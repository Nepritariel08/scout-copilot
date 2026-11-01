# SPDX-License-Identifier: MIT
from odoo import api, models
from odoo.exceptions import AccessDenied


class ResUsers(models.Model):
    _inherit = "res.users"

    @api.model
    @api.readonly
    def scout_own_identity_v1(self):
        """Fixed own-identity facts; no record, group, company or UID arguments.

        JSON-2 refuses IDs for @api.model methods. No permission, account or
        business record is written, and no business data is read with sudo.
        """
        user = self.env["res.users"].sudo().with_context({}).browse(self.env.uid).exists()
        if not user or not user.active:
            raise AccessDenied()
        # Do not use has_group/_get_group_ids here: that ORM cache is keyed only
        # by user ID and may already contain a portal caller's filtered result.
        # Sudo is limited to the authenticated user's effective group relation.
        group_ids = set(user.all_group_ids._ids)
        return {
            "contract": "scout-own-identity-v1",
            "uid": self.env.uid,
            "groups": {
                group: user.env.ref(group).id in group_ids
                for group in (
                    "base.group_portal",
                    "base.group_user",
                    "base.group_system",
                    "base.group_erp_manager",
                )
            },
        }
