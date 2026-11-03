import secrets
import time

from odoo.addons.auth_totp.controllers.home import Home
from odoo.addons.web.controllers.utils import _get_login_redirect_url, ensure_db
from odoo.exceptions import AccessDenied
from odoo.http import Controller, request, route
from odoo.http.session import authenticate

from .. import sso


def settings_for_request():
    settings = sso.load_settings()
    if (
        request.db != settings.database
        or request.httprequest.url_root.rstrip("/") != sso.ODOO_ORIGIN
    ):
        raise AccessDenied("SCOUT_ORIGIN_OR_DATABASE_INVALID")
    return settings


def redirect(location):
    response = request.redirect(location, 303)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


class WorkspaceLogin(Home):
    @route(type="http")
    def web_totp(self, *args, **kwargs):
        if sso.MFA_KEY in request.session:
            uid = request.session.get("pre_uid") or request.session.uid
            sso.check_pending_identity(request.env(user=uid))
        return super().web_totp(*args, **kwargs)

    @route()
    def web_login(self, *args, **kwargs):
        response = super().web_login(*args, **kwargs)
        if response.is_qweb:
            try:
                settings_for_request()
                response.qcontext["scout_microsoft_available"] = True
            except AccessDenied:
                response.qcontext["scout_microsoft_available"] = False
        return response


class ScoutWorkspace(Controller):
    @route("/scout/workspace", type="http", auth="user", methods=["GET"])
    def workspace(self):
        return request.render("scout_workspace.workspace", {})

    @route("/scout_sso/microsoft/start", type="http", auth="none", methods=["GET"])
    def start(self, **_kwargs):
        ensure_db()
        try:
            settings = settings_for_request()
            browser = request.session.get(sso.BROWSER_KEY) or secrets.token_urlsafe(32)
            request.session[sso.BROWSER_KEY] = browser
            now = time.time()
            pending = {
                state: value
                for state, value in request.session.get(sso.FLOWS_KEY, {}).items()
                if value["expires"] > now
            }
            if len(pending) >= sso.MAX_PENDING:
                raise AccessDenied()
            flow = sso.client(settings).initiate_auth_code_flow(
                scopes=["email"], redirect_uri=sso.CALLBACK, response_mode="query"
            )
            if (
                "auth_uri" not in flow
                or "state" not in flow
                or "code_verifier" not in flow
            ):
                raise AccessDenied()
            request.env["scout.workspace.login.flow"]._issue(
                sso.digest(flow["state"]), sso.digest(browser), settings.fingerprint
            )
            pending[flow["state"]] = {
                "flow": flow,
                "expires": now + sso.FLOW_SECONDS,
                "config": settings.fingerprint,
            }
            request.session[sso.FLOWS_KEY] = pending
            return redirect(flow["auth_uri"])
        except Exception:
            return redirect("/web/login?scout_sso_error=unavailable")

    @route("/scout_sso/microsoft/callback", type="http", auth="none", methods=["GET"])
    def callback(self, **kwargs):
        ensure_db()
        try:
            settings = settings_for_request()
            if set(kwargs) - {
                "state",
                "code",
                "error",
                "error_description",
                "error_uri",
                "session_state",
            }:
                raise AccessDenied()
            state = kwargs.get("state")
            if not isinstance(state, str) or not 16 <= len(state) <= 512:
                raise AccessDenied()
            pending = dict(request.session.get(sso.FLOWS_KEY, {}))
            entry = pending.pop(state, None)
            request.session[sso.FLOWS_KEY] = pending
            if (
                not entry
                or entry["expires"] <= time.time()
                or entry["config"] != settings.fingerprint
            ):
                raise AccessDenied()
            browser = request.session.get(sso.BROWSER_KEY)
            if not isinstance(browser, str) or not browser:
                raise AccessDenied()
            request.env["scout.workspace.login.flow"]._consume(
                sso.digest(state), sso.digest(browser), settings.fingerprint
            )
            # Never forward caller-supplied tokens/claims, nor retry a code after
            # a transport error. MSAL checks the stored state, PKCE and nonce.
            response = {
                key: kwargs[key] for key in ("state", "code", "error") if key in kwargs
            }
            if ("code" in response) == ("error" in response) or any(
                not isinstance(v, str) or len(v) > 8192 for v in response.values()
            ):
                raise AccessDenied()
            result = sso.client(settings).acquire_token_by_auth_code_flow(
                entry["flow"], response
            )
            tenant, oid = sso.validate_claims(settings, result)
            if sso.load_settings().fingerprint != settings.fingerprint:
                raise AccessDenied()
            binding = (
                request.env["scout.workspace.identity"]
                .sudo()
                .search(
                    [
                        ("tenant_id", "=", tenant),
                        ("object_id", "=", oid),
                        ("active", "=", True),
                    ],
                    limit=2,
                )
            )
            if len(binding) != 1 or not binding.user_id.active:
                raise AccessDenied()
            user = binding.user_id
            proof = sso.VerifiedProof(
                request.db,
                user.id,
                user.login,
                binding.id,
                str(binding.revision),
                tenant,
                oid,
                settings.fingerprint,
            )
            with sso.admitted(proof) as credential:
                info = authenticate(request.session, request.env, credential)
            return redirect(_get_login_redirect_url(info["uid"], "/scout/workspace"))
        except Exception:
            # No provider error text, token, claims or authorization code in logs,
            # rendered errors, exception chains or a retry path.
            return redirect("/web/login?scout_sso_error=denied")
