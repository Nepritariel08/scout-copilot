{
    "name": "Scout Workspace",
    "summary": "Explicit Microsoft identity binding and the Scout workspace entry",
    "version": "20.0.1.0.0",
    "license": "LGPL-3",
    "author": "Something Somewhere Consulting",
    "depends": ["web", "auth_totp"],
    "external_dependencies": {"python": ["msal", "jwt"]},
    "data": [
        "security/ir.access.csv",
        "views/workspace.xml",
        "views/bindings.xml",
    ],
    "application": True,
    "installable": True,
}
