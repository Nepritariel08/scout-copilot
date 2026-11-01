"""Seed only a disposable Odoo 20 Community qualification database.

Run with the official odoo shell inside the isolated qualification container.
Generated API keys are written only to a transient container file and copied by
the runner into its private temporary directory. This script never prints them.
"""

import json
import os
import secrets
from datetime import datetime, timedelta

from odoo import Command


output_dir = "/tmp/scout-odoo20-qualification"
os.makedirs(output_dir, mode=0o700, exist_ok=True)

main_company = env.ref("base.main_company").sudo()
main_company.write({"name": "Scout Qualification Company A"})
company_b = env["res.company"].sudo().create(
    {
        "name": "Scout Qualification Company B",
        "currency_id": main_company.currency_id.id,
    }
)

group_internal = env.ref("base.group_user")
group_portal = env.ref("base.group_portal")
group_project_user = env.ref("project.group_project_user")


def make_user(login, groups, allowed_companies):
    return env["res.users"].sudo().create(
        {
            "name": login,
            "login": login,
            "email": login + "@fixture.invalid",
            "password": secrets.token_urlsafe(32),
            "company_id": main_company.id,
            "company_ids": [Command.set([company.id for company in allowed_companies])],
            "group_ids": [Command.set(groups)],
        }
    )


employee_a = make_user(
    "scout-qual-employee-a",
    [group_internal.id, group_project_user.id],
    [main_company],
)
employee_b = make_user(
    "scout-qual-employee-b",
    [group_internal.id, group_project_user.id],
    [main_company, company_b],
)
portal_a = make_user(
    "scout-qual-customer-a",
    [group_portal.id],
    [main_company],
)
portal_b = make_user(
    "scout-qual-customer-b",
    [group_portal.id],
    [main_company],
)

admin = env.ref("base.user_admin").sudo()
admin.write(
    {
        "company_id": main_company.id,
        "company_ids": [Command.set([main_company.id, company_b.id])],
    }
)


def make_project(name, company, user):
    return (
        env["project.project"]
        .sudo()
        .with_context(allowed_company_ids=[company.id])
        .create(
            {
                "name": name,
                "company_id": company.id,
                "privacy_visibility": "followers",
                "user_id": user.id,
                "allowed_internal_user_ids": [Command.set([user.id])],
            }
        )
    )


def make_task(name, project, user):
    return (
        env["project.task"]
        .sudo()
        .with_context(allowed_company_ids=[project.company_id.id])
        .create(
            {
                "name": name,
                "project_id": project.id,
                "user_ids": [Command.set([user.id])],
            }
        )
    )


project_a = make_project(
    "Scout qualification employee A project", main_company, employee_a
)
project_b_same_company = make_project(
    "Scout qualification employee B project", main_company, employee_b
)
project_b_other_company = make_project(
    "Scout qualification second-company project", company_b, employee_b
)
task_a = make_task(
    "Scout qualification employee A task", project_a, employee_a
)
task_b_same_company = make_task(
    "Scout qualification employee B task", project_b_same_company, employee_b
)
task_b_other_company = make_task(
    "Scout qualification second-company task", project_b_other_company, employee_b
)

# Separate same-company portal customers. These projects are invited-only and
# have no employee A/B membership, preserving the existing employee fixture.
customer_projects = {}
customer_tasks = {}
customer_collaborators = {}
for label, customer in (("portalA", portal_a), ("portalB", portal_b)):
    project = make_project("Scout qualification " + label + " project", main_company, admin)
    project.write({"privacy_visibility": "invited_users"})
    collaborator = env["project.collaborator"].sudo().create({
        "project_id": project.id,
        "partner_id": customer.partner_id.id,
        "access_mode": "view",
    })
    task = make_task("Scout qualification " + label + " task", project, admin)
    # Follower access is intentionally retained during collaboration withdrawal:
    # the Scout customer adapter must still require current project access.
    task.message_subscribe(partner_ids=customer.partner_id.ids)
    customer_projects[label] = project.id
    customer_tasks[label] = task.id
    customer_collaborators[label] = collaborator.id


def make_key(user, label):
    expiry = datetime.now() + timedelta(days=3)
    return (
        env["res.users.apikeys"]
        .with_user(user.id)
        .sudo()
        ._generate("rpc", label, expiry)
    )


keys = {
    "employeeA": make_key(employee_a, "Scout Odoo 20 qualification employee A"),
    "employeeB": make_key(employee_b, "Scout Odoo 20 qualification employee B"),
    "portalA": make_key(portal_a, "Scout Odoo 20 qualification customer A"),
    "portalB": make_key(portal_b, "Scout Odoo 20 qualification customer B"),
    "admin": make_key(admin, "Scout Odoo 20 qualification admin denial"),
}

metadata = {
    "database": env.cr.dbname,
    "sourceInstanceId": "scout-odoo20-qualification",
    "companies": {"a": main_company.id, "b": company_b.id},
    "users": {
        "employeeA": employee_a.id,
        "employeeB": employee_b.id,
        "portalA": portal_a.id,
        "portalB": portal_b.id,
        "admin": admin.id,
    },
    "groups": {
        "internal": group_internal.id,
        "portal": group_portal.id,
        "projectUser": group_project_user.id,
    },
    "projects": {
        "employeeA": project_a.id,
        "employeeB": project_b_same_company.id,
        "secondCompany": project_b_other_company.id,
        **customer_projects,
    },
    "tasks": {
        "employeeA": task_a.id,
        "employeeB": task_b_same_company.id,
        "secondCompany": task_b_other_company.id,
        **customer_tasks,
    },
    "collaborators": customer_collaborators,
}

env.cr.commit()
for filename, value in (
    ("credentials.json", keys),
    ("metadata.json", metadata),
):
    path = os.path.join(output_dir, filename)
    with open(path, "x", encoding="utf-8") as stream:
        json.dump(value, stream, separators=(",", ":"))
    os.chmod(path, 0o600)
