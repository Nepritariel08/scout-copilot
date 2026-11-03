"""Protocol and request-local proof plumbing; no business data or bearer persistence."""

import hashlib
import json
import os
import stat
import time
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from functools import lru_cache
from importlib.metadata import version
from pathlib import Path
from uuid import UUID

from odoo.exceptions import AccessDenied

ODOO_ORIGIN = "https://odoo.somethingsomewhere.ph"
SCOUT_ORIGIN = "https://scout.somethingsomewhere.ph"
CALLBACK = ODOO_ORIGIN + "/scout_sso/microsoft/callback"
FLOW_SECONDS = 300
MAX_PENDING = 8
FLOWS_KEY = "scout_workspace_flows"
BROWSER_KEY = "scout_workspace_browser"
_proof = ContextVar("scout_workspace_verified_proof", default=None)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def guid(value):
    try:
        parsed = UUID(value)
        if parsed.int and str(parsed) == value.lower():
            return str(parsed)
    except (ValueError, TypeError, AttributeError):
        pass
    raise AccessDenied("SCOUT_IDENTITY_INVALID")


def protected_bytes(name):
    # Production qualification is POSIX-only. Windows fixtures inject settings;
    # they never pretend a POSIX mode proves a Windows ACL.
    path = Path(name)
    if os.name != "posix" or not path.is_absolute() or path.resolve() != path:
        raise AccessDenied("SCOUT_CONFIG_UNAVAILABLE")
    for parent in path.parents:
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise AccessDenied("SCOUT_CONFIG_UNAVAILABLE")
    info = path.lstat()
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_nlink != 1
        or info.st_uid not in (0, os.geteuid())
        or stat.S_IMODE(info.st_mode) != 0o600
        or not 0 < info.st_size <= 32768
    ):
        raise AccessDenied("SCOUT_CONFIG_UNAVAILABLE")
    return path.read_bytes()


@dataclass(frozen=True)
class Settings:
    tenant_id: str
    client_id: str
    database: str
    fingerprint: str
    client_secret: str = field(repr=False)

    @property
    def issuer(self):
        return "https://login.microsoftonline.com/" + self.tenant_id + "/v2.0"


def load_settings():
    try:
        raw = protected_bytes(os.environ["SCOUT_ODOO_SSO_CONFIG_FILE"])
        config = json.loads(raw)
        if set(config) != {
            "version",
            "enabled",
            "tenantId",
            "clientId",
            "database",
            "clientSecretFile",
        }:
            raise ValueError()
        if config["version"] != 1 or config["enabled"] is not True:
            raise ValueError()
        tenant, client = guid(config["tenantId"]), guid(config["clientId"])
        if (
            not isinstance(config["database"], str)
            or not config["database"]
            or len(config["database"]) > 100
        ):
            raise ValueError()
        secret = protected_bytes(config["clientSecretFile"]).decode().strip()
        if not 16 <= len(secret) <= 4096 or any(c.isspace() for c in secret):
            raise ValueError()
        return Settings(
            tenant,
            client,
            config["database"],
            digest(raw.decode() + "\0" + secret),
            secret,
        )
    except (KeyError, ValueError, TypeError, OSError, UnicodeError):
        raise AccessDenied("SCOUT_CONFIG_UNAVAILABLE") from None


def client(settings):
    import msal

    if version("msal") != "1.39.0" or version("PyJWT") != "2.14.0":
        raise AccessDenied("SCOUT_CLIENT_VERSION_UNQUALIFIED")
    return msal.ConfidentialClientApplication(
        settings.client_id,
        client_credential=settings.client_secret,
        authority="https://login.microsoftonline.com/" + settings.tenant_id,
        exclude_scopes=["offline_access"],
        timeout=10,
        enable_pii_log=False,
    )


@lru_cache(maxsize=4)
def signing_client(tenant):
    import jwt

    return jwt.PyJWKClient(
        "https://login.microsoftonline.com/" + guid(tenant) + "/discovery/v2.0/keys",
        cache_keys=True,
        cache_jwk_set=True,
        lifespan=300,
        timeout=10,
    )


def validate_claims(settings, result, now=None):
    """Accept only MSAL's token-endpoint result, never browser-supplied claims."""
    now = time.time() if now is None else now
    import jwt

    try:
        token = result["id_token"]
        if not isinstance(token, str) or not 0 < len(token) <= 32768:
            raise ValueError()
        key = signing_client(settings.tenant_id).get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            key.key,
            algorithms=["RS256"],
            audience=settings.client_id,
            issuer=settings.issuer,
            options={
                "require": ["exp", "iat", "iss", "aud", "sub", "oid", "tid", "nonce"]
            },
        )
        tenant, oid = guid(claims["tid"]), guid(claims["oid"])
        if (
            result.get("error")
            or tenant != settings.tenant_id
            or claims["iss"] != settings.issuer
            or claims["aud"] != settings.client_id
            or not isinstance(claims["sub"], str)
            or not claims["sub"]
            or type(claims["exp"]) not in (int, float)
            or not now < claims["exp"] <= now + 86400
            or type(claims["iat"]) not in (int, float)
            or not now - 86400 <= claims["iat"] <= now + 60
            or (
                "nbf" in claims
                and (
                    type(claims["nbf"]) not in (int, float) or claims["nbf"] > now + 60
                )
            )
        ):
            raise ValueError()
        return tenant, oid
    except (KeyError, TypeError, ValueError, jwt.PyJWTError):
        raise AccessDenied("SCOUT_IDENTITY_INVALID") from None


@dataclass
class VerifiedProof:
    database: str
    uid: int
    login: str
    binding_id: int
    binding_version: str
    tenant: str
    oid: str
    config_fingerprint: str
    ticket: object = field(default_factory=object, repr=False)
    used: bool = False


@contextmanager
def admitted(proof):
    previous = _proof.set(proof)
    try:
        yield {"type": "scout_entra", "login": proof.login, "proof": proof.ticket}
    finally:
        _proof.reset(previous)


def consume_proof(credential, env):
    proof = _proof.get()
    if (
        not isinstance(proof, VerifiedProof)
        or proof.used
        or credential.get("proof") is not proof.ticket
        or credential.get("login") != proof.login
        or env.cr.dbname != proof.database
        or env.uid != proof.uid
    ):
        raise AccessDenied()
    proof.used = True
    settings = load_settings()
    if (
        settings.database != proof.database
        or settings.fingerprint != proof.config_fingerprint
    ):
        raise AccessDenied()
    # Authentication metadata only. Lock the exact binding/user through native
    # session admission so a concurrent operator revocation cannot race the check.
    env.cr.execute(
        "SELECT id FROM scout_workspace_identity WHERE id=%s FOR SHARE",
        [proof.binding_id],
    )
    env.cr.execute("SELECT id FROM res_users WHERE id=%s FOR SHARE", [proof.uid])
    binding = env["scout.workspace.identity"].sudo().browse(proof.binding_id)
    binding.invalidate_recordset()
    env.user.invalidate_recordset()
    if (
        not binding.exists()
        or not binding.active
        or not env.user.active
        or binding.user_id.id != proof.uid
        or binding.tenant_id != proof.tenant
        or binding.object_id != proof.oid
        or str(binding.revision) != proof.binding_version
        or env.user.login != proof.login
        or settings.tenant_id != proof.tenant
    ):
        raise AccessDenied()
    return {"uid": proof.uid, "auth_method": "scout_entra", "mfa": "default"}
