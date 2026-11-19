# Barracuda Cloud-to-Cloud Backup: Google Workspace Admin Account Setup Scripts

This repository contains two Google Apps Script files from Barracuda. The scripts create the admin
account that Barracuda Cloud-to-Cloud Backup needs to back up your Google Workspace data.

You do not have to use these scripts. You can do the same steps manually in the Google Admin
console.

This README tells you what each script does, why it does it, and what it does not do. Read the
scripts before you run them. Each script is a Google Apps Script (a flavor of JavaScript) with comments to explain what is being done.

## Why Barracuda needs an admin account

To back up your domain, Barracuda must find the users, mailboxes, calendars, and shared drives in it. Google gives this information only to an admin account in your domain.

Barracuda does not sign in as this account. Barracuda does not know its password. Barracuda uses
**domain-wide delegation** instead. With it, a Super Admin lets an application act as users in the domain, for a fixed list of permissions only. You set up domain-wide delegation manually in your workspace. The scripts do not set it up.

## Which script to use

| You want to back up | Use this script | The script creates |
| --- | --- | --- |
| Gmail, Drive, Calendar, and Contacts | `gws-restricted-admin-setup.gs` | An admin account with no license and a limited, custom admin role |
| Google Classroom, in addition to Gmail, Drive, Calendar and Contacts | `gws-classroom-super-admin-setup.gs` | A Super Admin account with a license that includes Classroom |

Use the restricted admin script if you do not need Classroom backup. It gives the account fewer
privileges.

Classroom needs a Super Admin because of a Google rule. The Classroom API gives access to all the
classes in a domain to a Super Admin only. That Super Admin must also have a license that includes
Classroom. No custom admin role gives this access.

## What the restricted admin script does

Run the function `setupRestrictedAdmin()`. The script does these steps:

1. It checks that you added the two services that it needs. Refer to [Before you run a script](#before-you-run-a-script).
2. It reads the primary domain of your Google Workspace account. You do not edit the script.
3. It creates an organizational unit with the name `Automation`. An organizational unit (OU) is a folder for users in the Google Admin console. If the OU exists, the script uses it.
4. It checks that Google still offers all the privileges in the table below. If one is missing, the script stops before it creates the role or the user.
5. It creates a custom admin role with the name `CCB Read Access`. The role has only the privileges in the table below. If a role with this name exists, the script sets its privileges to this list.
6. It creates the user `ccb-reader-admin@<your primary domain>` in the `Automation` OU. The user gets a long, random password. The script does not show or keep the password. If the user exists, the script uses it.
7. If this user is already a Super Admin from the Classroom script, the script stops. It makes no changes, because a Super Admin already has all of these privileges.
8. It removes any Google Workspace license from this user only. The account does not need a license, so it does not use a paid seat. The script checks two times, with a 15-second pause. This is because automatic licensing can assign a license a short time after the user is created. The free Cloud Identity license stays on the user. That license has no cost.
9. It assigns the `CCB Read Access` role to the user.
10. It shows the email address to enter in the Barracuda connect wizard.

### The privileges in the custom role

| Privilege in the Admin console | Why Barracuda needs it |
| --- | --- |
| Users > Read | To list the users in your domain, so that Barracuda can find the data to back up. |
| Read Customer, with its sub-privileges | To read the details of your organization, for example the primary domain and the time zone. |
| License Management > License Read | To read which Google Workspace license each user has. |
| Drive and Docs, with its sub-privileges | To list all the shared drives in your domain. Google gives this list to an account with Drive admin privileges only. |

When you select a privilege in the Admin console, the console also selects its sub-privileges.
The script adds the same sub-privileges, so that the role is the same as a role that you make in
the console.

## What the Classroom script does

Run the function `setupSuperAdmin()`. The script does these steps:

1. It checks that you added the two services that it needs.
2. It reads the primary domain of your Google Workspace account. You do not edit the script.
3. It creates the `Automation` OU, or uses it if it exists.
4. It creates the user `ccb-reader-admin@<your primary domain>`, or uses it if it exists. If you ran the restricted admin script before, this is the same account. The email address does not change.
5. It makes sure that the user has a license that includes Classroom:
   - If the user already has such a license, the script makes no change.
   - If not, the script uses a license type that your domain already uses. It tries the free
     Google Workspace for Education Fundamentals license first. Then it tries the paid editions,
     from the lowest tier up. The list is at the top of the script.
   - If the user has a different Google Workspace edition, the script changes it to the selected
     edition. A user can have only one Google Workspace edition.
   - If your domain uses no license that includes Classroom, the script stops. At that point, the OU and the user exist, but the script changes no license. Assign a license to the user in the Admin console, then run the script again.
6. It makes the user a Super Admin.
7. It reminds you to turn on Classroom for the `Automation` OU. The script cannot change this setting. Go to **Admin console > Apps > Google Workspace > Classroom > Service status**.
8. It shows the email address to enter in the Barracuda connect wizard.

**Cost:** A paid license uses one seat of your Google Workspace subscription. On a Flexible plan, Google bills you for one more seat. The Education Fundamentals license is free.

**Security:** A Super Admin has full control of your domain. Barracuda does not sign in as this
account, and nobody knows its password. Barracuda acts only through domain-wide delegation, with
the permissions that you grant in the connect wizard.

## What the scripts do not do

- They do not send data to Barracuda or to any other place outside your Google Workspace. They
  call only two Google APIs: the Admin SDK Directory API and the Enterprise License Manager API.
- They do not read email, files, calendar events, contacts, or classes.
- They do not change other users. They change only the `ccb-reader-admin` account.
- They do not show, store, or send the password of the account.
- They do not set up domain-wide delegation.
- They do not turn on Classroom.
- They do not use external libraries or download code.

## Before you run a script

You must be a Super Admin in your Google Workspace domain.

1. Read the script.
2. Open <https://script.google.com>.
3. Click **New project**.
4. Delete the example code in `Code.gs`.
5. Paste the script into `Code.gs`.
6. Click **Services > +** and add **Admin SDK API**.
7. Click **Services > +** and add **Enterprise License Manager API**.
8. Select the setup function and click **Run**.

Use one script per project. The two scripts use the same names, so Apps Script does not run a project that contains both.

The first time you run the script, Google asks you to allow permissions. The script needs them to manage users, organizational units, admin roles, and license assignments in your domain. You give these permissions to your own Apps Script project, not to Barracuda.

The script writes each step to the **Execution log**. You can delete the Apps Script project after the script completes. The account, the OU, and the role stay.

## Running a script again

You can run each script again safely. The script finds the items that already exist and makes
only the changes that are necessary.

To add Classroom backup to an existing connection, run the Classroom script. It upgrades the same account. Then reauthorize the connection in Barracuda and select Classroom.

## Important

- Do not suspend or delete the `ccb-reader-admin` account while you use CCB. If you do,
  backups stop.
- Do not remove privileges from the `CCB Read Access` role. A missing privilege causes the
  connection check or later backups to fail.
- For the Classroom account, do not remove its license. If you do, Classroom backups stop.

## Removing the account

If you stop using Barracuda Cloud-to-Cloud Backup, you can remove what the scripts created:

1. In the Google Admin console, delete the user `ccb-reader-admin@<your primary domain>`.
2. Go to **Account > Admin roles** and delete the `CCB Read Access` role.
3. Delete the `Automation` OU, but only if it is empty and nothing else uses it.
4. Go to **Security > Access and data control > API controls > Manage Domain Wide Delegation**.
5. Delete the entry for the Barracuda client ID.

## License
Copyright 2026 Barracuda Networks, Inc. Licensed under the MIT License
