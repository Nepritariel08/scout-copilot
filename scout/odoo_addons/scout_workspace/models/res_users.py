from odoo import models

from ..sso import MFA_KEY, consume_proof, finalize_pending_identity


class ResUsers(models.Model):
    _inherit = "res.users"

    def _check_credentials(self, credential, env):
        if credential.get("type") == "scout_entra":
            if not env or env.get("interactive") is not True:
                from odoo.exceptions import AccessDenied

                raise AccessDenied()
            return consume_proof(credential, self.env)
        info = super()._check_credentials(credential, env)
        # A successful different PRIMARY login supersedes an unfinished SSO
        # challenge. TOTP itself must keep the marker through native finalize.
        if credential.get("type") != "totp":
            from odoo.http import request

            if request:
                request.session.pop(MFA_KEY, None)
        return info

    def _after_session_login(self):
        finalize_pending_identity(self.env)
        return super()._after_session_login()
