/**
 * Google Workspace Cloud-to-Cloud Backup super admin email setup for Classroom
 *
 * Creates a licensed super admin account that CCB can use to back up Google
 * Classroom, Gmail, Drive, Calendar, and Contacts. The Classroom API gives domain-wide course
 * access to a super admin only, and only when that super admin has a license that includes
 * Classroom.
 *
 * If you already ran the restricted admin setup script, this script upgrades the same account.
 * The email address does not change.
 *
 * Run setupSuperAdmin() as a Super Admin. The script reads your primary domain from your
 * Google Workspace account, so you do not need to edit anything.
 *
 * Paste this script into an Apps Script project, then add two services (Services > +):
 * Admin SDK API (AdminDirectory) and Enterprise License Manager API (AdminLicenseManager).
 */
function setupSuperAdmin() {
  SuperAdminSetup.run();
}

const SuperAdminSetup = (() => {
  const USER_NAME = 'ccb-reader-admin';   // local part of the account's email address
  const OU_NAME   = 'Automation';

  const CUSTOMER = 'my_customer';
  const LICENSE_PRODUCT_ID = 'Google-Apps';

  // Google Workspace SKUs that include Classroom, in the order the script tries them: the free
  // education license first, then paid editions from the lowest tier up. The script only assigns a
  // SKU that the domain already uses. Nonprofit editions use the same SKU IDs.
  const CLASSROOM_SKUS = [
    { skuId: '1010070001', name: 'Google Workspace for Education Fundamentals', free: true },
    { skuId: '1010020027', name: 'Google Workspace Business Starter' },
    { skuId: '1010020028', name: 'Google Workspace Business Standard' },
    { skuId: '1010020025', name: 'Google Workspace Business Plus' },
    { skuId: '1010060003', name: 'Google Workspace Enterprise Essentials' },
    { skuId: '1010020029', name: 'Google Workspace Enterprise Starter' },
    { skuId: '1010020026', name: 'Google Workspace Enterprise Standard' },
    { skuId: '1010020020', name: 'Google Workspace Enterprise Plus' },
  ];

  function run() {
    checkAdvancedServices();
    const customer = AdminDirectory.Customers.get(CUSTOMER);
    const userEmail = `${USER_NAME}@${customer.customerDomain}`;

    // 1. Create the OU and the user, or use the ones from the restricted admin setup script
    ensureOrgUnit(customer.id, OU_NAME);
    const user = ensureUser(userEmail);

    // 2. Make sure the user has a license that includes Classroom
    retry(() => ensureClassroomLicense(customer.id, userEmail), 'license assignment');

    // 3. Make the user a super admin. The custom role from the restricted admin setup script stays
    //    assigned; the super admin role includes its privileges.
    retry(() => ensureSuperAdmin(user), 'super admin assignment');

    Logger.log('Setup complete.');
    Logger.log(`Make sure Classroom is turned on for /${OU_NAME}: Admin console > Apps > ` +
      'Google Workspace > Classroom > Service status.');
    Logger.log(`Use this email address when you connect CCB to your Google Workspace: ${userEmail}`);
  }

  function ensureUser(email) {
    try {
      const user = AdminDirectory.Users.insert({
        primaryEmail: email,
        name: { givenName: 'Cloud-to-Cloud Backup', familyName: 'Admin' },
        // Nobody signs in as this account, so the password is not kept.
        password: Utilities.getUuid() + Utilities.getUuid(),
        orgUnitPath: `/${OU_NAME}`,
        changePasswordAtNextLogin: false
      });
      Logger.log(`Created user ${email}`);
      return user;
    } catch (e) {
      if (!String(e).includes('exists')) throw e;
      Logger.log(`User ${email} already exists`);
      return AdminDirectory.Users.get(email);
    }
  }

  function ensureClassroomLicense(customerId, email) {
    const current = listAll(token =>
      AdminLicenseManager.LicenseAssignments.listForProduct(LICENSE_PRODUCT_ID, customerId,
        { maxResults: 1000, pageToken: token }), 'items')
      .filter(a => a.userId.toLowerCase() === email.toLowerCase());

    const classroomSkuIds = CLASSROOM_SKUS.map(s => s.skuId);
    const existing = current.find(a => classroomSkuIds.includes(a.skuId));
    if (existing) {
      Logger.log(`User already has a Classroom license (${existing.skuId})`);
      return;
    }

    const sku = CLASSROOM_SKUS.find(s => isSkuUsedInDomain(customerId, s.skuId));
    if (!sku) {
      throw new Error('No license that includes Classroom is in use in this domain. Assign a ' +
        `Classroom license to ${email} in the Admin console, then run this script again.`);
    }

    // A user can hold one Google Workspace edition. Change any other edition to the Classroom one.
    const other = current[0];
    if (other) {
      AdminLicenseManager.LicenseAssignments.update(
        { skuId: sku.skuId }, LICENSE_PRODUCT_ID, other.skuId, email);
      Logger.log(`Changed license ${other.skuId} to ${sku.name} (${sku.skuId})`);
    } else {
      AdminLicenseManager.LicenseAssignments.insert({ userId: email }, LICENSE_PRODUCT_ID, sku.skuId);
      Logger.log(`Assigned license ${sku.name} (${sku.skuId})`);
    }
    if (!sku.free) {
      Logger.log('This is a paid license. On a Flexible plan, Google bills it as one more seat.');
    }
  }

  function isSkuUsedInDomain(customerId, skuId) {
    try {
      const res = AdminLicenseManager.LicenseAssignments.listForProductAndSku(
        LICENSE_PRODUCT_ID, skuId, customerId, { maxResults: 1 });
      return (res.items || []).length > 0;
    } catch (e) {
      // The License Manager API rejects a SKU the customer has no subscription for.
      if (/not found|404|invalid|400/i.test(String(e))) return false;
      throw e;
    }
  }

  // Use the user from insert or get: Users.get does not find a new user for a short time after it
  // is created.
  function ensureSuperAdmin(user) {
    if (user.isAdmin) {
      Logger.log(`${user.primaryEmail} is already a super admin`);
      return;
    }
    AdminDirectory.Users.makeAdmin({ status: true }, user.id);
    Logger.log(`Made ${user.primaryEmail} a super admin`);
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
        // A missing Classroom license is not a timing problem, so do not wait for it.
        if (String(e).includes('No license that includes Classroom')) throw e;
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
