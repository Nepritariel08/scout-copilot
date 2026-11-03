import base64
import json
import secrets
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

import jwt
import msal
from cryptography.hazmat.primitives.asymmetric import rsa
from odoo import SUPERUSER_ID, Command, api
from odoo.addons.auth_totp.controllers.home import Home as TotpHome
from odoo.addons.auth_totp.models.totp import hotp
from odoo.exceptions import AccessDenied, AccessError, ValidationError
from odoo.http import Response, request_var
from odoo.http.session import Session, authenticate, get_default_session
from odoo.tests import TransactionCase, tagged
from psycopg2 import IntegrityError
from werkzeug.test import EnvironBuilder
from werkzeug.wrappers import Request as HttpRequest

from .. import sso
from ..controllers.main import ScoutWorkspace, WorkspaceLogin

TENANT = "11111111-1111-4111-8111-111111111111"
CLIENT = "22222222-2222-4222-8222-222222222222"
OBJECT = "33333333-3333-4333-8333-333333333333"
OTHER = "44444444-4444-4444-8444-444444444444"


class OfflineHTTP:
    """MSAL's real protocol implementation; only the HTTP transport is synthetic."""

    def __init__(self, issuer):
        self.issuer = issuer
        self.id_token = None
        self.exchanges = 0

    def get(self, url, **_kwargs):
        if not url.endswith("/.well-known/openid-configuration"):
            raise AssertionError("Unexpected authentication HTTP request")
        return self.response(
            {
                "issuer": self.issuer,
                "authorization_endpoint": "https://login.microsoftonline.com/"
                + TENANT
                + "/oauth2/v2.0/authorize",
                "token_endpoint": "https://login.microsoftonline.com/"
                + TENANT
                + "/oauth2/v2.0/token",
                "jwks_uri": "https://login.microsoftonline.com/"
                + TENANT
                + "/discovery/v2.0/keys",
            }
        )

    def post(self, url, data=None, **_kwargs):
        if url != "https://login.microsoftonline.com/" + TENANT + "/oauth2/v2.0/token":
            raise AssertionError("Unexpected authentication token endpoint")
        self.exchanges += 1
        if (
            not data.get("code_verifier")
            or data.get("grant_type") != "authorization_code"
        ):
            raise AssertionError("Missing code/PKCE exchange")
        return self.response(
            {
                "access_token": "synthetic-opaque-not-persisted",
                "id_token": self.id_token,
                "token_type": "Bearer",
                "expires_in": 3600,
            }
        )

    @staticmethod
    def response(body):
        return SimpleNamespace(
            status_code=200, headers={}, text=json.dumps(body), json=lambda: body
        )


@tagged("post_install", "-at_install")
class TestWorkspace(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.signing_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.jwk = jwt.algorithms.RSAAlgorithm.to_jwk(
            cls.signing_key.public_key(), as_dict=True
        )
        cls.jwk.update({"kid": "synthetic-signing-key", "use": "sig", "alg": "RS256"})

    def setUp(self):
        super().setUp()
        self.settings = sso.Settings(
            TENANT,
            CLIENT,
            self.env.cr.dbname,
            "c" * 64,
            "synthetic-secret-not-a-real-credential",
        )
        self.internal = (
            self.env["res.users"]
            .with_context(no_reset_password=True)
            .create(
                {
                    "name": "Synthetic internal",
                    "login": "scout-internal@example.invalid",
                    "password": "synthetic-password",
                    "group_ids": [Command.set([self.env.ref("base.group_user").id])],
                }
            )
        )
        self.portal = (
            self.env["res.users"]
            .with_context(no_reset_password=True)
            .create(
                {
                    "name": "Synthetic portal",
                    "login": "scout-portal@example.invalid",
                    "password": "synthetic-password",
                    "group_ids": [Command.set([self.env.ref("base.group_portal").id])],
                }
            )
        )
        self.binding = self.env["scout.workspace.identity"].create(
            {"user_id": self.internal.id, "tenant_id": TENANT, "object_id": OBJECT}
        )

    def proof(self, binding=None):
        binding = self.binding if binding is None else binding
        return sso.VerifiedProof(
            self.env.cr.dbname,
            binding.user_id.id,
            binding.user_id.login,
            binding.id,
            str(binding.revision),
            binding.tenant_id,
            binding.object_id,
            self.settings.fingerprint,
        )

    def snapshot(self, user):
        user.invalidate_recordset()
        return (
            user.login,
            user.partner_id.id,
            user.group_ids.ids,
            user.company_id.id,
            user.company_ids.ids,
            user.share,
        )

    def request(self):
        session = Session(get_default_session(), "s" * 42)
        session.db = self.env.cr.dbname
        request = SimpleNamespace(
            session=session,
            db=self.env.cr.dbname,
            env=self.env,
            cookies={},
            default_lang=lambda: "en_US",
            httproot=sso.ODOO_ORIGIN,
            httprequest=HttpRequest(
                EnvironBuilder(
                    base_url=sso.ODOO_ORIGIN + "/",
                    environ_base={"REMOTE_ADDR": "127.0.0.1"},
                ).get_environ()
            ),
            future_response=Response(),
            redirect=lambda location, status=303: Response(
                status=status, headers={"Location": location}
            ),
        )

        def update_context(**values):
            request.env = request.env(context={**request.env.context, **values})

        request.update_context = update_context
        request.update_env = lambda user: setattr(
            request, "env", request.env(user=user)
        )
        request.render = lambda *_args, **_kwargs: Response("synthetic MFA form")
        return request

    @contextmanager
    def pending_mfa(self, origin="sso"):
        self.internal.totp_secret = "IRXWM5LT"
        self.internal.totp_last_counter = 0
        request = self.request()
        token = request_var.set(request)
        try:
            with patch.object(sso, "load_settings", return_value=self.settings):
                if origin == "sso":
                    with sso.admitted(self.proof()) as credential:
                        authenticate(request.session, self.env, credential)
                else:
                    authenticate(
                        request.session,
                        self.env,
                        {
                            "type": "password",
                            "login": self.internal.login,
                            "password": "synthetic-password",
                        },
                    )
                self.assertIsNone(request.session.uid)
                self.assertEqual(request.session["pre_uid"], self.internal.id)
                yield request
        finally:
            request_var.reset(token)

    def complete_mfa(self, request, mode):
        if mode == "trusted":
            key = (
                self.env["auth_totp.device"]
                .with_user(self.internal)
                .sudo()
                ._generate(
                    "browser",
                    "Synthetic remembered browser",
                    self.env.cr.now() + timedelta(hours=1),
                )
            )
            request.cookies = {"td_id": key}
            request.httprequest.method = "GET"
            kwargs = {}
        else:
            request.httprequest.method = "POST"
            kwargs = {
                "totp_token": str(
                    hotp(base64.b32decode("IRXWM5LT"), int(time.time() / 30))
                )
            }
        with patch.object(TotpHome, "_login_redirect", return_value="/scout/workspace"):
            return WorkspaceLogin().web_totp(**kwargs)

    def test_native_totp_and_trusted_device_complete_unchanged_sso_challenge(self):
        for mode in ("totp", "trusted"):
            with self.subTest(mode=mode), self.pending_mfa() as request:
                self.assertIn(sso.MFA_KEY, request.session)
                self.complete_mfa(request, mode)
                self.assertEqual(request.session.uid, self.internal.id)
                self.assertNotIn(sso.MFA_KEY, request.session)
                # Fully finalized sessions resume native Odoo lifecycle.
                self.binding.active = False
                self.internal.with_user(self.internal)._after_session_login()
                self.assertEqual(request.session.uid, self.internal.id)
            self.binding.active = True

    def test_sso_mfa_finalization_rechecks_revocation_for_totp_and_trusted_device(self):
        for mode in ("totp", "trusted"):
            for change in (
                "mapping_disabled",
                "mapping_revision",
                "config_revision",
                "config_disabled",
                "user_disabled",
                "expired",
            ):
                with (
                    self.subTest(mode=mode, change=change),
                    self.pending_mfa() as request,
                ):
                    if change == "mapping_disabled":
                        self.binding.active = False
                    elif change == "mapping_revision":
                        self.binding.write({"active": True})
                    elif change == "user_disabled":
                        self.internal.active = False
                    elif change == "expired":
                        marker = dict(request.session[sso.MFA_KEY])
                        marker["expires_at"] = time.time() - 1
                        request.session[sso.MFA_KEY] = marker
                    changed = sso.Settings(
                        TENANT,
                        CLIENT,
                        self.env.cr.dbname,
                        "d" * 64,
                        "synthetic-rotated-credential",
                    )
                    if change == "config_disabled":
                        setting = patch.object(
                            sso, "load_settings", side_effect=AccessDenied()
                        )
                    else:
                        setting = patch.object(
                            sso,
                            "load_settings",
                            return_value=changed
                            if change == "config_revision"
                            else self.settings,
                        )
                    with setting, self.assertRaises(AccessDenied):
                        self.complete_mfa(request, mode)
                    self.assertIsNone(request.session.uid)
                    self.assertNotIn("pre_uid", request.session)
                    self.assertNotIn(sso.MFA_KEY, request.session)
                self.internal.active = True
                self.binding.active = True

    def test_password_mfa_supersedes_pending_sso_and_ignores_sso_config_revocation(
        self,
    ):
        for mode in ("totp", "trusted"):
            with self.subTest(mode=mode), self.pending_mfa() as request:
                authenticate(
                    request.session,
                    self.env,
                    {
                        "type": "password",
                        "login": self.internal.login,
                        "password": "synthetic-password",
                    },
                )
                self.assertNotIn(sso.MFA_KEY, request.session)
                self.binding.active = False
                with patch.object(sso, "load_settings", side_effect=AccessDenied()):
                    self.complete_mfa(request, mode)
                self.assertEqual(request.session.uid, self.internal.id)
            self.binding.active = True

    def test_native_session_preserves_internal_and_portal_accounts_and_password(self):
        for user, binding in (
            (self.internal, self.binding),
            (
                self.portal,
                self.env["scout.workspace.identity"].create(
                    {"user_id": self.portal.id, "tenant_id": TENANT, "object_id": OTHER}
                ),
            ),
        ):
            before = self.snapshot(user)
            request = self.request()
            token = request_var.set(request)
            try:
                with (
                    patch.object(sso, "load_settings", return_value=self.settings),
                    sso.admitted(self.proof(binding)) as credential,
                ):
                    info = authenticate(request.session, self.env, credential)
                    self.assertEqual(
                        info,
                        {
                            "uid": user.id,
                            "auth_method": "scout_entra",
                            "mfa": "default",
                        },
                    )
                self.assertEqual(request.session.uid, user.id)
                self.assertTrue(request.session.should_rotate)
                self.assertEqual(before, self.snapshot(user))
                # Existing password authentication still works after SSO.
                self.assertEqual(
                    self.env["res.users"].authenticate(
                        {
                            "type": "password",
                            "login": user.login,
                            "password": "synthetic-password",
                        },
                        {"interactive": True},
                    )["uid"],
                    user.id,
                )
            finally:
                request_var.reset(token)

    def test_native_totp_is_not_skipped(self):
        self.internal.totp_secret = "IRXWM5LT"
        request = self.request()
        token = request_var.set(request)
        try:
            with (
                patch.object(sso, "load_settings", return_value=self.settings),
                sso.admitted(self.proof()) as credential,
            ):
                info = authenticate(request.session, self.env, credential)
            self.assertEqual(info["mfa"], "default")
            self.assertIsNone(request.session.uid)
            self.assertEqual(request.session["pre_uid"], self.internal.id)
        finally:
            request_var.reset(token)

    def test_proof_is_one_use_request_local_and_unavailable_to_rpc(self):
        credential = {
            "type": "scout_entra",
            "login": self.internal.login,
            "proof": {"forged": True},
        }
        with self.assertRaises(AccessDenied):
            self.internal.with_user(self.internal)._check_credentials(
                credential, {"interactive": True}
            )
        with (
            patch.object(sso, "load_settings", return_value=self.settings),
            sso.admitted(self.proof()) as admitted,
        ):
            self.internal.with_user(self.internal)._check_credentials(
                admitted, {"interactive": True}
            )
            with self.assertRaises(AccessDenied):
                self.internal.with_user(self.internal)._check_credentials(
                    admitted, {"interactive": True}
                )
        with self.assertRaises(AccessDenied):
            self.internal.with_user(self.internal)._check_credentials(
                admitted, {"interactive": True}
            )

    def test_revoked_rotated_or_reissued_binding_denies_original_proof(self):
        for change in ({"active": False}, {"object_id": OTHER}, {"active": True}):
            proof = self.proof()
            self.binding.write(change)
            with (
                patch.object(sso, "load_settings", return_value=self.settings),
                sso.admitted(proof) as credential,
            ):
                with self.assertRaises(AccessDenied):
                    self.internal.with_user(self.internal)._check_credentials(
                        credential, {"interactive": True}
                    )
            self.binding.write({"active": True, "object_id": OBJECT})

    def test_disabled_user_rotated_config_wrong_user_and_noninteractive_deny(self):
        proof = self.proof()
        self.internal.active = False
        with (
            patch.object(sso, "load_settings", return_value=self.settings),
            sso.admitted(proof) as credential,
        ):
            with self.assertRaises(AccessDenied):
                self.internal.with_user(self.internal)._check_credentials(
                    credential, {"interactive": True}
                )
        self.internal.active = True
        changed = sso.Settings(
            TENANT, CLIENT, self.env.cr.dbname, "d" * 64, "synthetic-other-secret"
        )
        with (
            patch.object(sso, "load_settings", return_value=changed),
            sso.admitted(self.proof()) as credential,
        ):
            with self.assertRaises(AccessDenied):
                self.internal.with_user(self.internal)._check_credentials(
                    credential, {"interactive": True}
                )
        for user, interactive in ((self.portal, True), (self.internal, False)):
            with (
                patch.object(sso, "load_settings", return_value=self.settings),
                sso.admitted(self.proof()) as credential,
            ):
                with self.assertRaises(AccessDenied):
                    user.with_user(user)._check_credentials(
                        credential, {"interactive": interactive}
                    )

    def test_identity_management_is_admin_only_and_does_not_autolink_email(self):
        for user in (self.internal, self.portal):
            with self.assertRaises(AccessError):
                self.env["scout.workspace.identity"].with_user(user).create(
                    {"user_id": self.portal.id, "tenant_id": TENANT, "object_id": OTHER}
                )
        self.assertFalse(
            self.env["scout.workspace.identity"].search(
                [("tenant_id", "=", TENANT), ("object_id", "=", OTHER)]
            )
        )
        self.assertFalse(
            self.env["res.users"].search([("login", "=", "unknown@example.invalid")])
        )
        with self.assertRaises(AccessError):
            self.binding.write({"revision": 1})

    def test_mapping_constraints_reject_duplicate_identity_user_and_invalid_guid(self):
        for values in (
            {"user_id": self.portal.id, "tenant_id": TENANT, "object_id": OBJECT},
            {"user_id": self.internal.id, "tenant_id": TENANT, "object_id": OTHER},
        ):
            with (
                self.assertRaises((ValidationError, IntegrityError)),
                self.env.cr.savepoint(),
            ):
                self.env["scout.workspace.identity"].create(values)
                self.env.flush_all()
        with self.assertRaises(ValidationError), self.env.cr.savepoint():
            self.env["scout.workspace.identity"].create(
                {
                    "user_id": self.portal.id,
                    "tenant_id": TENANT,
                    "object_id": "not-a-guid",
                }
            )

    def flow_hashes(self):
        return (
            sso.digest(secrets.token_urlsafe(32)),
            sso.digest(secrets.token_urlsafe(32)),
            self.settings.fingerprint,
        )

    def test_durable_admission_is_bound_and_survives_callback_rollback(self):
        hashes = self.flow_hashes()
        model = self.env["scout.workspace.login.flow"]
        model._issue(*hashes)
        with self.assertRaises(AccessDenied):
            model._consume(hashes[0], "f" * 64, hashes[2])
        with self.env.registry.cursor() as outer:
            api.Environment(outer, SUPERUSER_ID, {})[model._name]._consume(*hashes)
            outer.rollback()
        with self.assertRaises(AccessDenied):
            model._consume(*hashes)

    def test_concurrent_admission_has_one_winner(self):
        hashes = self.flow_hashes()
        self.env["scout.workspace.login.flow"]._issue(*hashes)
        model = self.env["scout.workspace.login.flow"]

        def consume(_index):
            # Avoid constructing registries in test worker threads: the runner
            # holds its registry lock. Production's admission method itself
            # opens independent real SQL cursors and does no ORM writes.
            try:
                model._consume(*hashes)
                return True
            except AccessDenied:
                return False

        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(consume, range(2))), [False, True])

    def test_expired_admission_and_pending_limit(self):
        state, browser, config = self.flow_hashes()
        model = self.env["scout.workspace.login.flow"]
        model._issue(state, browser, config)
        with self.env.registry.cursor() as cr:
            cr.execute(
                "UPDATE scout_workspace_login_flow SET expires_at=clock_timestamp() AT TIME ZONE 'UTC' - interval '1 second' WHERE state_hash=%s",
                [state],
            )
            cr.commit()
        with self.assertRaises(AccessDenied):
            model._consume(state, browser, config)
        for _ in range(sso.MAX_PENDING):
            model._issue(sso.digest(secrets.token_urlsafe(32)), browser, config)
        with self.assertRaises(AccessDenied):
            model._issue(sso.digest(secrets.token_urlsafe(32)), browser, config)

    def protocol(self, overrides=None):
        transport = OfflineHTTP(self.settings.issuer)
        app = msal.ConfidentialClientApplication(
            CLIENT,
            client_credential=self.settings.client_secret,
            authority="https://login.microsoftonline.com/" + TENANT,
            instance_discovery=False,
            http_client=transport,
            exclude_scopes=["offline_access"],
        )
        flow = app.initiate_auth_code_flow(
            scopes=["email"], redirect_uri=sso.CALLBACK, response_mode="query"
        )
        query = parse_qs(urlparse(flow["auth_uri"]).query)
        claims = {
            "iss": self.settings.issuer,
            "aud": CLIENT,
            "sub": "synthetic-subject",
            "tid": TENANT,
            "oid": OBJECT,
            "iat": int(time.time()),
            "exp": int(time.time()) + 3600,
            "nonce": query["nonce"][0],
        }
        claims.update(overrides or {})
        transport.id_token = jwt.encode(
            claims,
            self.signing_key,
            algorithm="RS256",
            headers={"kid": "synthetic-signing-key"},
        )
        jwks = jwt.PyJWKClient("https://synthetic.invalid/never-called")
        jwks.fetch_data = lambda: {"keys": [self.jwk]}
        return app, flow, transport, jwks, query

    def test_real_msal_pkce_state_nonce_and_signed_jwks_claims(self):
        app, flow, transport, jwks, query = self.protocol()
        other = app.initiate_auth_code_flow(scopes=["email"], redirect_uri=sso.CALLBACK)
        self.assertNotEqual(flow["state"], other["state"])
        self.assertNotEqual(flow["code_verifier"], other["code_verifier"])
        self.assertEqual(query["response_type"], ["code"])
        self.assertEqual(query["code_challenge_method"], ["S256"])
        self.assertEqual(set(query["scope"][0].split()), {"openid", "profile", "email"})
        result = app.acquire_token_by_auth_code_flow(
            flow, {"state": flow["state"], "code": "synthetic-one-use-code"}
        )
        with patch.object(sso, "signing_client", return_value=jwks):
            self.assertEqual(
                sso.validate_claims(self.settings, result), (TENANT, OBJECT)
            )
        self.assertEqual(transport.exchanges, 1)

    def test_real_protocol_rejects_wrong_audience_issuer_nonce_tenant_object_and_expiry(
        self,
    ):
        for changes in (
            {"aud": OTHER},
            {"iss": "https://wrong.example.invalid/v2.0"},
            {"nonce": "wrong-nonce"},
            {"tid": OTHER},
            {"oid": "not-a-guid"},
            {"exp": int(time.time()) - 10},
        ):
            with self.subTest(changes=changes):
                app, flow, _http, jwks, _query = self.protocol(changes)
                expected = (
                    RuntimeError if "nonce" in changes else (AccessDenied, ValueError)
                )
                with (
                    patch.object(sso, "signing_client", return_value=jwks),
                    self.assertRaises(expected),
                ):
                    result = app.acquire_token_by_auth_code_flow(
                        flow, {"state": flow["state"], "code": "synthetic-code"}
                    )
                    sso.validate_claims(self.settings, result)
        app, flow, http, _jwks, _query = self.protocol()
        with self.assertRaises(ValueError):
            app.acquire_token_by_auth_code_flow(
                flow, {"state": "wrong-state", "code": "synthetic-code"}
            )
        self.assertEqual(http.exchanges, 0)

    def test_signed_token_wrong_key_and_missing_claims_deny(self):
        app, flow, _http, jwks, _query = self.protocol()
        result = app.acquire_token_by_auth_code_flow(
            flow, {"state": flow["state"], "code": "synthetic-code"}
        )
        wrong = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        claims = dict(result["id_token_claims"])
        result["id_token"] = jwt.encode(
            claims, wrong, algorithm="RS256", headers={"kid": "synthetic-signing-key"}
        )
        with (
            patch.object(sso, "signing_client", return_value=jwks),
            self.assertRaises(AccessDenied),
        ):
            sso.validate_claims(self.settings, result)
        del claims["oid"]
        result["id_token"] = jwt.encode(
            claims,
            self.signing_key,
            algorithm="RS256",
            headers={"kid": "synthetic-signing-key"},
        )
        with (
            patch.object(sso, "signing_client", return_value=jwks),
            self.assertRaises(AccessDenied),
        ):
            sso.validate_claims(self.settings, result)

    def test_callback_spends_before_exchange_and_never_retries_failure(self):
        app, flow, http, jwks, _query = self.protocol()
        request = self.request()
        browser = "synthetic-server-side-browser-binding"
        request.session[sso.BROWSER_KEY] = browser
        request.session[sso.FLOWS_KEY] = {
            flow["state"]: {
                "flow": flow,
                "expires": time.time() + 300,
                "config": self.settings.fingerprint,
            }
        }
        hashes = (
            sso.digest(flow["state"]),
            sso.digest(browser),
            self.settings.fingerprint,
        )
        self.env["scout.workspace.login.flow"]._issue(*hashes)
        token = request_var.set(request)
        try:
            with (
                patch.object(sso, "load_settings", return_value=self.settings),
                patch.object(sso, "client", return_value=app),
                patch.object(sso, "signing_client", return_value=jwks),
                patch("odoo.addons.scout_workspace.controllers.main.ensure_db"),
            ):
                response = ScoutWorkspace().callback(
                    state=flow["state"], code="synthetic-code"
                )
                self.assertEqual(response.status_code, 303)
                self.assertEqual(request.session.uid, self.internal.id)
                self.assertNotIn("id_token", dict(request.session))
                self.assertNotIn("access_token", dict(request.session))
                again = ScoutWorkspace().callback(
                    state=flow["state"], code="synthetic-code"
                )
                self.assertEqual(again.location, "/web/login?scout_sso_error=denied")
                self.assertEqual(http.exchanges, 1)
        finally:
            request_var.reset(token)

    def test_two_tabs_have_independent_flows_and_unknown_oid_never_autolinks_email(
        self,
    ):
        app, _flow, _http, _jwks, _query = self.protocol()
        request = self.request()
        token = request_var.set(request)
        try:
            with (
                patch.object(sso, "load_settings", return_value=self.settings),
                patch.object(sso, "client", return_value=app),
                patch("odoo.addons.scout_workspace.controllers.main.ensure_db"),
            ):
                ScoutWorkspace().start()
                ScoutWorkspace().start()
                self.assertEqual(len(request.session[sso.FLOWS_KEY]), 2)
                states = list(request.session[sso.FLOWS_KEY].values())
                self.assertNotEqual(
                    states[0]["flow"]["code_verifier"],
                    states[1]["flow"]["code_verifier"],
                )
        finally:
            request_var.reset(token)
        app, flow, http, jwks, _query = self.protocol(
            {"oid": OTHER, "email": self.internal.login}
        )
        request = self.request()
        browser = "synthetic-other-browser"
        request.session[sso.BROWSER_KEY] = browser
        request.session[sso.FLOWS_KEY] = {
            flow["state"]: {
                "flow": flow,
                "expires": time.time() + 300,
                "config": self.settings.fingerprint,
            }
        }
        self.env["scout.workspace.login.flow"]._issue(
            sso.digest(flow["state"]), sso.digest(browser), self.settings.fingerprint
        )
        count = self.env["res.users"].search_count([])
        token = request_var.set(request)
        try:
            with (
                patch.object(sso, "load_settings", return_value=self.settings),
                patch.object(sso, "client", return_value=app),
                patch.object(sso, "signing_client", return_value=jwks),
                patch("odoo.addons.scout_workspace.controllers.main.ensure_db"),
            ):
                self.assertEqual(
                    ScoutWorkspace()
                    .callback(state=flow["state"], code="synthetic-code")
                    .location,
                    "/web/login?scout_sso_error=denied",
                )
                self.assertIsNone(request.session.uid)
                self.assertEqual(self.env["res.users"].search_count([]), count)
                self.assertFalse(
                    self.env["scout.workspace.identity"].search(
                        [("object_id", "=", OTHER)]
                    )
                )
                self.assertEqual(http.exchanges, 1)
        finally:
            request_var.reset(token)

    def test_exchange_timeout_is_spent_and_not_retried(self):
        app, flow, http, _jwks, _query = self.protocol()
        request = self.request()
        browser = "synthetic-timeout-browser"
        request.session[sso.BROWSER_KEY] = browser
        entry = {
            "flow": flow,
            "expires": time.time() + 300,
            "config": self.settings.fingerprint,
        }
        request.session[sso.FLOWS_KEY] = {flow["state"]: entry}
        hashes = (
            sso.digest(flow["state"]),
            sso.digest(browser),
            self.settings.fingerprint,
        )
        self.env["scout.workspace.login.flow"]._issue(*hashes)
        attempts = []

        def timeout(*_args, **_kwargs):
            attempts.append(True)
            raise TimeoutError("synthetic transport uncertainty")

        http.post = timeout
        token = request_var.set(request)
        try:
            with (
                patch.object(sso, "load_settings", return_value=self.settings),
                patch.object(sso, "client", return_value=app),
                patch("odoo.addons.scout_workspace.controllers.main.ensure_db"),
            ):
                self.assertEqual(
                    ScoutWorkspace()
                    .callback(state=flow["state"], code="synthetic-code")
                    .location,
                    "/web/login?scout_sso_error=denied",
                )
                # Simulate a stale concurrent server-session copy, not just its pop.
                request.session[sso.FLOWS_KEY] = {flow["state"]: entry}
                ScoutWorkspace().callback(state=flow["state"], code="synthetic-code")
                self.assertEqual(len(attempts), 1)
                self.assertIsNone(request.session.uid)
        finally:
            request_var.reset(token)
