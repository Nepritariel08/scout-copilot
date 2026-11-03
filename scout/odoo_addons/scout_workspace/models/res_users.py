from odoo import models

from ..sso import consume_proof


class ResUsers(models.Model):
    _inherit = "res.users"

    def _check_credentials(self, credential, env):
        if credential.get("type") == "scout_entra":
            if not env or env.get("interactive") is not True:
                from odoo.exceptions import AccessDenied

                raise AccessDenied()
            return consume_proof(credential, self.env)
        return super()._check_credentials(credential, env)
