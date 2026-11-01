# SPDX-License-Identifier: MIT
from odoo import Command
from odoo.tests.common import TransactionCase, tagged


@tagged("-at_install", "post_install")
class TestOwnIdentity(TransactionCase):
    def test_portal_attestation_bypasses_only_own_group_visibility(self):
        portal = self.env["res.users"].sudo().create({
            "name": "Synthetic Scout attestation customer",
            "login": "scout-attestation-customer@fixture.invalid",
            "group_ids": [Command.set([self.env.ref("base.group_portal").id])],
        })
        caller = self.env["res.users"].with_user(portal).sudo(False)
        before_groups = portal.sudo().all_group_ids._ids
        before_users = self.env["res.users"].sudo().search_count([])
        before_keys = self.env["res.users.apikeys"].sudo().search_count([])
        self.env.flush_all()
        self.env.transaction.invalidate_ormcache()
        # Reproduce the stock contract mismatch in the exact installed release:
        # portal cannot read res.groups; has_group can cache the empty relation.
        self.assertFalse(caller.browse(portal.id).has_group("base.group_portal"))
        self.assertFalse(caller.browse(portal.id).all_group_ids)
        expected = {
            "contract": "scout-own-identity-v1",
            "uid": portal.id,
            "groups": {
                "base.group_portal": True,
                "base.group_user": False,
                "base.group_system": False,
                "base.group_erp_manager": False,
            },
        }
        self.assertEqual(
            caller.with_context(uid=self.env.uid, active_id=self.env.uid)
            .scout_own_identity_v1(),
            expected,
        )
        self.assertFalse(caller.env.su)
        self.assertFalse(caller.env["res.groups"].has_access("read"))
        self.assertEqual(portal.sudo().all_group_ids._ids, before_groups)
        self.assertEqual(self.env["res.users"].sudo().search_count([]), before_users)
        self.assertEqual(self.env["res.users.apikeys"].sudo().search_count([]), before_keys)

        # A current role change invalidates old attestation, even for the same
        # caller recordset/context and after the empty has_group cache existed.
        portal.sudo().write({
            "group_ids": [Command.set([self.env.ref("base.group_user").id])],
        })
        current = caller.scout_own_identity_v1()
        self.assertEqual(current["uid"], portal.id)
        self.assertIs(current["groups"]["base.group_portal"], False)
        self.assertIs(current["groups"]["base.group_user"], True)
