from odoo import api, fields, models
from odoo.exceptions import AccessError, ValidationError

from ..sso import guid


class ScoutIdentity(models.Model):
    _name = "scout.workspace.identity"
    _description = "Explicit Scout Microsoft identity binding"

    user_id = fields.Many2one("res.users", required=True, ondelete="restrict")
    tenant_id = fields.Char(required=True)
    object_id = fields.Char(required=True)
    active = fields.Boolean(default=True)
    revision = fields.Integer(default=1, readonly=True, copy=False)

    _identity_unique = models.Constraint(
        "UNIQUE(tenant_id, object_id)", "This Microsoft identity is already bound."
    )
    _user_unique = models.Constraint(
        "UNIQUE(user_id)", "This Odoo user already has a Microsoft identity binding."
    )

    @api.model_create_multi
    def create(self, values_list):
        if any("revision" in values for values in values_list):
            raise AccessError("The identity revision is server-managed.")
        return super().create(values_list)

    def write(self, values):
        self.check_access("write")
        if "revision" in values:
            raise AccessError("The identity revision is server-managed.")
        for binding in self:
            binding.flush_recordset(["revision"])
            self.env.cr.execute(
                "SELECT revision FROM scout_workspace_identity WHERE id=%s FOR UPDATE",
                [binding.id],
            )
            revision = self.env.cr.fetchone()[0]
            super(ScoutIdentity, binding).write({**values, "revision": revision + 1})
        return True

    @api.constrains("tenant_id", "object_id")
    def _check_identifiers(self):
        for binding in self:
            try:
                if (
                    guid(binding.tenant_id) != binding.tenant_id
                    or guid(binding.object_id) != binding.object_id
                ):
                    raise ValueError()
            except Exception:
                raise ValidationError(
                    "Use canonical nonempty tenant and object GUIDs."
                ) from None
