/**
 * Google Workspace Cloud-to-Cloud Backup restricted admin email setup
 *
 * Creates an unlicensed admin account with a custom, read-only admin role. 
 * CCB can use this account to back up Gmail, Drive, Calendar, and Contacts. Google Classroom needs a
 * licensed super admin instead; use the super admin setup script for Classroom.
 *
 * Run setupRestrictedAdmin() as a Super Admin. The script reads your primary domain from your
 * Google Workspace account, so you do not need to edit anything.
 *
 * Paste this script into an Apps Script project, then add two services (Services > +):
 * Admin SDK API (AdminDirectory) and Enterprise License Manager API (AdminLicenseManager).
 */
function setupRestrictedAdmin() {
  RestrictedAdminSetup.run();
}

const RestrictedAdminSetup = (() => {
  const USER_NAME = 'ccb-reader-admin';   // local part of the account's email address
  const OU_NAME   = 'Automation';
  const ROLE_NAME = 'CCB Read Access';
  const ROLE_DESC = 'Read-only admin privileges for a backup service account';

  // Service IDs are the same in every Google Workspace account.
  const ADMIN_API_SERVICE = '00haapch16h1ysv';
  const DRIVE_SERVICE     = '03dy6vkm2sk0pzo';

  // The privileges the role grants, as the Admin SDK names them. Selecting a privilege in the
  // Admin console also selects its child privileges, so each group lists the parent and all of
  // its children, the same as a role made in the console. A privilege name can exist under more
  // than one service, so each entry carries its service ID.
  const ROLE_PRIVILEGES = [
    // Users > Read: list the users in the domain
    { privilegeName: 'USERS_RETRIEVE', serviceId: ADMIN_API_SERVICE },

    // Read Customer: read the organization details
    { privilegeName: 'API_APPS_ENTERPRISE_CUSTOMER_READ', serviceId: ADMIN_API_SERVICE },
    { privilegeName: 'API_APPS_ENTERPRISE_CUSTOMER_READ_BRANDING_SETTINGS', serviceId: ADMIN_API_SERVICE },
    { privilegeName: 'API_APPS_ENTERPRISE_CUSTOMER_READ_CONTACT_INFO', serviceId: ADMIN_API_SERVICE },
    { privilegeName: 'API_APPS_ENTERPRISE_CUSTOMER_READ_ONBOARD_SETTINGS', serviceId: ADMIN_API_SERVICE },
    { privilegeName: 'API_APPS_ENTERPRISE_CUSTOMER_READ_PROFILE_SETTINGS', serviceId: ADMIN_API_SERVICE },
    { privilegeName: 'API_APPS_ENTERPRISE_CUSTOMER_READ_SUPPORT_SETTINGS', serviceId: ADMIN_API_SERVICE },
    { privilegeName: 'API_APPS_ENTERPRISE_CUSTOMER_READ_TIME_ZONE_SETTINGS', serviceId: ADMIN_API_SERVICE },

    // License Management > License Read: read the license assignments in the domain
    { privilegeName: 'LICENSING_READ', serviceId: ADMIN_API_SERVICE },

    // Drive and Docs: list the shared drives in the domain
    { privilegeName: 'APP_ADMIN', serviceId: DRIVE_SERVICE },
    { privilegeName: 'DOCS_TEMPLATE_ADMIN', serviceId: DRIVE_SERVICE },
    { privilegeName: 'MANAGE_CLASSIC_GOOGLE_SITES', serviceId: DRIVE_SERVICE },
    { privilegeName: 'MIGRATE_TO_TEAM_DRIVE', serviceId: DRIVE_SERVICE },
    { privilegeName: 'VIEW_SITE_DETAILS', serviceId: DRIVE_SERVICE },
  ];

  const CUSTOMER = 'my_customer';

  function run() {
    checkAdvancedServices();
    const customer = AdminDirectory.Customers.get(CUSTOMER);
    const userEmail = `${USER_NAME}@${customer.customerDomain}`;

    // 1. Create the OU (skip if it already exists)
    ensureOrgUnit(customer.id, OU_NAME);

    // 2. Create the custom admin role, or bring an existing one up to the full privilege set
    const role = ensureRole(checkPrivilegesExist(ROLE_PRIVILEGES));

    // 3. Create the user in the OU. Nobody signs in as this account, so the password is not kept.
    let user;
    try {
      user = AdminDirectory.Users.insert({
        primaryEmail: userEmail,
        name: { givenName: 'Cloud-to-Cloud Backup', familyName: 'Admin' },
        password: Utilities.getUuid() + Utilities.getUuid(),
        orgUnitPath: `/${OU_NAME}`,
        changePasswordAtNextLogin: false
      });
      Logger.log(`Created user ${userEmail}`);
    } catch (e) {
      if (!String(e).includes('exists')) throw e;
      user = AdminDirectory.Users.get(userEmail);
      Logger.log(`User ${userEmail} already exists`);
    }

    // A super admin comes from the super admin setup script. Its license is needed for Classroom,
    // so keep it. Use the user from insert or get: Users.get does not find a new user for a short
    // time after it is created.
    if (user.isAdmin) {
      Logger.log(`${userEmail} is a super admin from the super admin setup script. Nothing to ` +
        'change: a super admin already has every privilege this script grants.');
      Logger.log(`Use this email address when you connect CCB to your Google Workspace: ${userEmail}`);
      return;
    }

    // 4. Assign the custom role (retry: new users take a moment to propagate)
    retry(() => assignRole(role.roleId, user.id), 'role assignment');

    // 5. Remove any auto-assigned Workspace license. This step is last, so that a license error
    //    does not stop the role assignment.
    const keptLicenses = removeWorkspaceLicenses(customer.id, userEmail);

    if (keptLicenses.length) {
      console.warn('One more step is necessary. Your domain assigns licenses automatically, so ' +
        `${userEmail} got a Google Workspace license (${keptLicenses.join(', ')}). The account ` +
        'does not need a license, and Google does not let a script remove an automatically ' +
        'assigned license. Open https://admin.google.com/ac/billing/licensesettings, turn off ' +
        `automatic licensing for the /${OU_NAME} organizational unit, then run this script again.`);
    } else {
      Logger.log('Setup complete.');
    }
    Logger.log(`Use this email address when you connect CCB to your Google Workspace: ${userEmail}`);
  }

  function ensureOrgUnit(customerId, name) {
    try {
      const ou = AdminDirectory.Orgunits.get(customerId, name);
      Logger.log(`OU ${ou.orgUnitPath} already exists`);
      return ou;
    } catch (e) {
      if (!/not found|404|Invalid Ou Id/i.test(String(e))) throw e;
    }

    const ou = {
      name: name,
      description: 'Service accounts for integrations'
    };
    // Create under the root OU, using its ID rather than '/' when one is available
    const rootId = getRootOrgUnitId(customerId);
    if (rootId) {
      ou.parentOrgUnitId = rootId;
    } else {
      ou.parentOrgUnitPath = '/';
    }
    const created = AdminDirectory.Orgunits.insert(ou, customerId);
    Logger.log(`Created OU ${created.orgUnitPath}`);
    return created;
  }

  function getRootOrgUnitId(customerId) {
    // Any top-level OU reports the root's ID as its parentOrgUnitId
    const res = AdminDirectory.Orgunits.list(customerId, { type: 'children' });
    const child = (res.organizationUnits || [])[0];
    return child ? child.parentOrgUnitId : null;
  }

  // Stops before anything changes if Google no longer offers one of the privileges.
  function checkPrivilegesExist(wanted) {
    const all = AdminDirectory.Privileges.list(CUSTOMER).items;
    const missing = wanted.filter(w => !findPrivilege(all, w.privilegeName, w.serviceId));
    if (missing.length) {
      throw new Error('Privileges not found: ' +
        missing.map(m => `${m.privilegeName} (serviceId ${m.serviceId})`).join(', '));
    }
    return wanted;
  }

  function findPrivilege(list, name, serviceId) {
    for (const p of list || []) {
      if (p.privilegeName === name && p.serviceId === serviceId) return p;
      const child = findPrivilege(p.childPrivileges, name, serviceId);
      if (child) return child;
    }
    return null;
  }

  function ensureRole(rolePrivileges) {
    const existing = listAll(token =>
      AdminDirectory.Roles.list(CUSTOMER, { pageToken: token }), 'items')
      .find(r => r.roleName === ROLE_NAME);

    if (!existing) {
      const role = AdminDirectory.Roles.insert({
        roleName: ROLE_NAME,
        roleDescription: ROLE_DESC,
        rolePrivileges: rolePrivileges
      }, CUSTOMER);
      Logger.log(`Created role ${ROLE_NAME} (${role.roleId})`);
      return role;
    }

    // A role from an earlier run can have fewer privileges. Replace its list with the full set.
    const role = AdminDirectory.Roles.patch({
      roleDescription: ROLE_DESC,
      rolePrivileges: rolePrivileges
    }, CUSTOMER, existing.roleId);
    Logger.log(`Updated role ${ROLE_NAME} (${role.roleId})`);
    return role;
  }

  function assignRole(roleId, userId) {
    const assignments = AdminDirectory.RoleAssignments.list(CUSTOMER, { userKey: userId }).items || [];
    if (assignments.some(a => String(a.roleId) === String(roleId))) {
      Logger.log(`Role ${ROLE_NAME} is already assigned`);
      return;
    }
    AdminDirectory.RoleAssignments.insert({
      roleId: roleId,
      assignedTo: userId,
      scopeType: 'CUSTOMER'
    }, CUSTOMER);
    Logger.log(`Assigned role ${ROLE_NAME}`);
  }

  // Returns the SKU IDs of the licenses that the script could not remove.
  function removeWorkspaceLicenses(customerId, email) {
    const kept = new Set();
    // Automatic licensing can assign a license a short time after the user is created, so look
    // twice with a pause between.
    for (let pass = 1; pass <= 2; pass++) {
      if (pass > 1) Utilities.sleep(15000);
      const notRemoved = retry(() => removeLicensesForProduct(customerId, 'Google-Apps', email),
        'license removal (Google-Apps)') || [];
      notRemoved.forEach(skuId => kept.add(skuId));
    }
    return [...kept];
  }

  // Returns the SKU IDs of the licenses that automatic licensing assigned. Google does not let the
  // API remove these, and no API turns off automatic licensing for an OU.
  function removeLicensesForProduct(customerId, productId, email) {
    const assignments = listAll(token =>
      AdminLicenseManager.LicenseAssignments.listForProduct(productId, customerId,
        { maxResults: 1000, pageToken: token }), 'items');
    const autoAssigned = [];
    assignments
      .filter(a => a.userId.toLowerCase() === email.toLowerCase())
      .forEach(a => {
        try {
          AdminLicenseManager.LicenseAssignments.remove(productId, a.skuId, email);
          Logger.log(`Removed license ${a.skuId}`);
        } catch (e) {
          if (!String(e).includes('Auto License un-assignment is not allowed')) throw e;
          autoAssigned.push(a.skuId);
        }
      });
    return autoAssigned;
  }

  function listAll(fetchPage, itemsKey) {
    const items = [];
    let token;
    do {
      const res = fetchPage(token);
      items.push(...(res[itemsKey] || []));
      token = res.nextPageToken;
    } while (token);
    return items;
  }

  function retry(fn, label, attempts = 6) {
    for (let i = 1; i <= attempts; i++) {
      try { return fn(); }
      catch (e) {
        if (String(e).includes('already exists')) return;
        if (i === attempts) throw e;
        Logger.log(`${label} attempt ${i} failed (${e}), retrying...`);
        Utilities.sleep(5000 * i);
      }
    }
  }

  // A service that is not added gives a ReferenceError that does not say what to do.
  function checkAdvancedServices() {
    const missing = [];
    if (typeof AdminDirectory === 'undefined') missing.push('Admin SDK API');
    if (typeof AdminLicenseManager === 'undefined') missing.push('Enterprise License Manager API');
    if (missing.length) {
      throw new Error(`Add these services (Services > +), then run the script again: ${missing.join(', ')}`);
    }
  }

  return { run };
})();
