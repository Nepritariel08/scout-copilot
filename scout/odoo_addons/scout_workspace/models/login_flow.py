from datetime import timedelta

from odoo import SUPERUSER_ID, api, fields, models
from odoo.exceptions import AccessDenied
from psycopg2 import Error as DatabaseError

from ..sso import FLOW_SECONDS, MAX_PENDING


class ScoutLoginFlow(models.Model):
    _name = "scout.workspace.login.flow"
    _description = "One-use Microsoft authentication admission metadata"

    state_hash = fields.Char(required=True)
    browser_hash = fields.Char(required=True)
    config_hash = fields.Char(required=True)
    expires_at = fields.Datetime(required=True)
    consumed_at = fields.Datetime()

    _state_unique = models.Constraint(
        "UNIQUE(state_hash)", "This sign-in state already exists."
    )

    @api.model
    def _issue(self, state_hash, browser_hash, config_hash):
        with self.env.registry.cursor() as cr:
            cr.execute("SET LOCAL lock_timeout='3s'")
            cr.execute("SET LOCAL statement_timeout='5s'")
            cr.execute("SELECT pg_advisory_xact_lock(%s)", [int(browser_hash[:15], 16)])
            cr.execute(
                "SELECT COUNT(*) FROM scout_workspace_login_flow WHERE browser_hash=%s AND consumed_at IS NULL AND expires_at > clock_timestamp() AT TIME ZONE 'UTC'",
                [browser_hash],
            )
            if cr.fetchone()[0] >= MAX_PENDING:
                raise AccessDenied("SCOUT_SIGNIN_PENDING_LIMIT")
            cr.execute("SELECT clock_timestamp() AT TIME ZONE 'UTC'")
            now = cr.fetchone()[0]
            api.Environment(cr, SUPERUSER_ID, {})[self._name].create(
                {
                    "state_hash": state_hash,
                    "browser_hash": browser_hash,
                    "config_hash": config_hash,
                    "expires_at": now + timedelta(seconds=FLOW_SECONDS),
                }
            )
            cr.commit()

    @api.model
    def _consume(self, state_hash, browser_hash, config_hash):
        try:
            with self.env.registry.cursor() as cr:
                cr.execute("SET LOCAL lock_timeout='3s'")
                cr.execute("SET LOCAL statement_timeout='5s'")
                cr.execute(
                    "UPDATE scout_workspace_login_flow SET consumed_at=clock_timestamp() AT TIME ZONE 'UTC' WHERE state_hash=%s AND browser_hash=%s AND config_hash=%s AND consumed_at IS NULL AND expires_at > clock_timestamp() AT TIME ZONE 'UTC' RETURNING id",
                    [state_hash, browser_hash, config_hash],
                )
                if not cr.fetchone():
                    raise AccessDenied("SCOUT_SIGNIN_STATE_INVALID")
                # This commit precedes token exchange. A timeout/rollback cannot
                # turn an attempted authorization code into an automatic retry.
                cr.commit()
        except DatabaseError:
            raise AccessDenied("SCOUT_SIGNIN_STATE_UNCERTAIN") from None
