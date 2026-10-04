// Organization integrations: Cisco Umbrella on MX networks, XDR per network,
// the Cisco Spaces link, and the lists of deployable and deployed integrations.
// Deployed ones are worked out from the Secure Access, XDR and Spaces state, so
// the lists can't drift from it.

import { stored } from '../config.js';
import { arrayParam, badRequest, paginateItems } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { isHostname } from '../validate.js';
import { byId, limit, mxNet, orgOf } from './common.js';

const NET = '/networks/{networkId}/appliance/umbrella';
const ORG = '/organizations/{organizationId}';
const MAX_POLICIES = 100;
const MAX_EXCLUSIONS = 1000;
const POLICY_ID = /^\d{1,20}$/;

const everything = (items) => ({ items, meta: { counts: { items: { total: items.length, remaining: 0 } } } });
const digitsFor = (ctx, kind, id, n) => new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:${kind}:${id}`)).digits(n);

// ── Umbrella ──

// Kept with the network's appliance settings. The API key and secret are
// stored but never returned.
const umbrellaOf = (net) => stored(net, 'applianceUmbrella', () => ({ account: null, enabled: false, policies: [], exclusions: [] }));

function accountOf(net) {
  const u = umbrellaOf(net);
  if (!u.account) throw badRequest('No Umbrella account is connected to this network');
  return u;
}

const policyId = (b) => {
  const id = b.policy?.id;
  if (typeof id !== 'string' || !POLICY_ID.test(id)) throw badRequest("'policy.id' must be an Umbrella policy ID such as 13408726");
  return id;
};

// The same key always names the same Umbrella organization.
function connect(ctx) {
  const net = mxNet(ctx);
  const api = ctx.body.api;
  for (const k of ['key', 'secret']) if (typeof api?.[k] !== 'string' || !api[k].trim()) throw badRequest(`'api.${k}' is required`);
  const u = umbrellaOf(net);
  const orgId = digitsFor(ctx, 'umbrellaOrg', api.key, 7);
  if (u.account?.orgId !== orgId) u.policies = [];
  u.account = { key: api.key, secret: api.secret, orgId };
  return { umbrella: { organization: { id: orgId } } };
}

function disconnect(ctx) {
  const u = accountOf(mxNet(ctx));
  Object.assign(u, { account: null, enabled: false, policies: [] });
}

function exclusions(ctx) {
  const net = mxNet(ctx);
  const domains = limit(ctx.body.domains ?? [], MAX_EXCLUSIONS, 'Umbrella domain exclusions');
  const next = domains.map((d, i) => {
    if (typeof d !== 'string' || !isHostname(d)) throw badRequest(`'domains[${i}]' must be a domain name such as example.com (no wildcards)`);
    return d.toLowerCase();
  });
  const u = umbrellaOf(net);
  u.exclusions = [...new Set(next)];
  return { domains: u.exclusions };
}

const policiesJson = (net, u) => ({ network: { id: net.id }, policies: u.policies.map((id) => ({ id })) });

// Adding a policy already applied changes nothing.
function addPolicy(ctx) {
  const net = mxNet(ctx);
  const id = policyId(ctx.body);
  const u = accountOf(net);
  if (!u.policies.includes(id)) {
    limit([...u.policies, id], MAX_POLICIES, 'Umbrella policies');
    u.policies.push(id);
  }
  return policiesJson(net, u);
}

function removePolicy(ctx) {
  const net = mxNet(ctx);
  const id = policyId(ctx.body);
  const u = accountOf(net);
  if (!u.policies.includes(id)) throw badRequest(`Umbrella policy ${id} is not applied to this network`);
  u.policies = u.policies.filter((x) => x !== id);
}

function protection(ctx) {
  const net = mxNet(ctx);
  const enabled = ctx.body.enabled;
  if (typeof enabled !== 'boolean') throw badRequest("'enabled' must be true or false");
  const u = enabled ? accountOf(net) : umbrellaOf(net);
  u.enabled = enabled;
  const on = enabled && u.account;
  const origin = on ? digitsFor(ctx, 'umbrellaOrigin', `${u.account.orgId}:${net.id}`, 9) : null;
  return { umbrella: { organization: { id: on ? u.account.orgId : null }, origin: { id: origin } }, enabled };
}

// ── XDR ──

// Network IDs with XDR on, repointed by world.js.
const xdrOf = (org) => (org.xdrNetworks ??= { networkIds: [] });
const xdrOn = (org) => new Set((org.xdrNetworks?.networkIds ?? []).filter((id) => org.networks.some((n) => n.id === id && n.productTypes.includes('appliance'))));
const xdrNets = (org) => org.networks.filter((n) => n.productTypes.includes('appliance')).sort(byId);
const eligible = (net) => !!net.mx;

const xdrJson = (net, on, products) => ({ networkId: net.id, productTypes: products, name: net.name, enabled: on, isEligible: eligible(net) });

function xdrList(ctx) {
  const org = orgOf(ctx);
  const ids = arrayParam(ctx.query, 'networkIds');
  const on = xdrOn(org);
  const nets = xdrNets(org).filter((n) => !ids.length || ids.includes(n.id));
  return paginateItems(ctx, nets, (n) => n.id, { def: 20, max: 100 }, (n) => xdrJson(n, on.has(n.id), on.has(n.id) ? ['appliance'] : []));
}

// Checks every row before anything changes, then answers one row per network.
function setXdr(enable) {
  return (ctx) => {
    const org = orgOf(ctx);
    const rows = ctx.body.networks ?? [];
    if (!rows.length) throw badRequest("'networks' must list at least one network");
    const nets = rows.map((row, i) => {
      const id = row?.networkId;
      if (typeof id !== 'string') throw badRequest(`'networks[${i}].networkId' is required`);
      const net = xdrNets(org).find((n) => n.id === id);
      if (!net) throw badRequest(`'networks[${i}].networkId' ${id} is not a network with an appliance in this organization`);
      if (!Array.isArray(row.productTypes) || !row.productTypes.includes('appliance')) throw badRequest(`'networks[${i}].productTypes' must be ['appliance']`);
      if (enable && !eligible(net)) throw badRequest(`Network ${id} is not eligible for XDR: it has no security appliance`);
      return net;
    });
    const store = xdrOf(org);
    const done = [...new Set(nets)];
    for (const net of done) {
      const has = store.networkIds.includes(net.id);
      if (enable && !has) store.networkIds.push(net.id);
      if (!enable && has) store.networkIds = store.networkIds.filter((x) => x !== net.id);
    }
    return { networks: done.map((n) => xdrJson(n, enable, ['appliance'])) };
  };
}

// ── Spaces ──

// Acme Test Lab is seeded as integrated (world.js); there is no API to link one.
const STATES = (email) => ['Spaces account created', 'Meraki Organization Import initiated', 'Importing Meraki Organization Administrators', `Invite email sent to ${email}`];

function spacesStatus(ctx) {
  const s = orgOf(ctx).spaces;
  if (!s) return { status: false, states: [] };
  return { status: true, states: STATES(s.email), email: s.email, accountName: s.accountName, accountType: s.accountType };
}

function removeSpaces(ctx) {
  const org = orgOf(ctx);
  if (!org.spaces) return { status: false, message: 'The organization has no Spaces integration' };
  org.spaces = null;
  return { status: true, message: 'Successfully removed the Spaces integration' };
}

// ── Deployable and deployed ──

const LOGO = 'https://n1.meraki.com/images/integrations';
const REDIRECT = 'https://dashboard.meraki.com/integrations';
const DEPLOYABLE = [
  ['Axis', 'Axis Cameras', 'partner', ['Cameras'], 'Bring Axis cameras into the dashboard alongside Meraki devices.', 'GA', false],
  ['Catalyst SD-WAN', 'Catalyst SD-WAN', 'Cisco', ['SD-WAN'], 'Connect to a Catalyst SD-WAN overlay to enable simple SD-WAN interconnects.', 'Beta', true],
  ['Cisco Spaces', 'Cisco Spaces', 'Cisco', ['Location', 'Wayfinding'], 'Turn wireless and sensor data into location and occupancy insights.', 'GA', true],
  ['Genea', 'Genea Access Control', 'Genea', ['Access control'], 'Manage door access with Genea and see events next to camera footage.', 'GA', false],
  ['OAuth', 'OAuth Application', 'partner', ['OAuth'], 'Grant a partner application scoped access to this organization.', 'GA', false],
  ['PagerDuty', 'PagerDuty', 'partner', ['Alerting'], 'Send dashboard alerts to PagerDuty incidents.', 'GA', false],
  ['Secure Access', 'Secure Access', 'Cisco', ['Security', 'SSE'], 'Connect MX sites to Cisco Secure Access for cloud security.', 'GA', true],
  ['Secure Connect', 'Secure Connect', 'Cisco', ['Security', 'SASE'], 'Extend the Meraki SD-WAN fabric with a cloud security service.', 'GA', true],
  ['Splunk', 'Splunk', 'partner', ['Logging'], 'Stream dashboard events and syslog to Splunk.', 'GA', false],
  ['XDR', 'Cisco XDR', 'Cisco', ['Security'], 'Share MX security events with Cisco XDR for detection and response.', 'GA', true],
];
const slugOf = (type) => type.toLowerCase().replace(/[^a-z0-9]+/g, '-');

// Single-instance integrations stop being deployable once deployed, and XDR
// needs a network with a security appliance.
function deployable(ctx) {
  const org = orgOf(ctx);
  const taken = { 'Secure Access': !!org.sase?.integration, 'Cisco Spaces': !!org.spaces, XDR: !xdrNets(org).some(eligible) };
  return everything(
    DEPLOYABLE.map(([type, name, provider, tags, shortDescription, releaseType, isCiscoProduct]) => ({
      type,
      name,
      provider,
      tags,
      shortDescription,
      isDeployable: !taken[type],
      releaseType,
      logoUrl: `${LOGO}/${slugOf(type)}.png`,
      redirectUrl: `${REDIRECT}/${slugOf(type)}`,
      isCiscoProduct,
    })),
  );
}

function deployed(ctx) {
  const org = orgOf(ctx);
  const row = (type, id) => {
    const [, name, provider, tags] = DEPLOYABLE.find((d) => d[0] === type);
    return { id, type, name, provider, tags };
  };
  const items = [];
  if (org.spaces) items.push(row('Cisco Spaces', digitsFor(ctx, 'spacesIntegration', org.id, 5)));
  if (org.sase?.integration) items.push(row('Secure Access', org.sase.integration.integrationId));
  if (xdrOn(org).size) items.push(row('XDR', digitsFor(ctx, 'xdrIntegration', org.id, 5)));
  return everything(items);
}

export default [
  { op: 'connectNetworkApplianceUmbrellaAccount', method: 'POST', path: `${NET}/account/connect`, status: 200, handler: connect },
  { op: 'disconnectNetworkApplianceUmbrellaAccount', method: 'POST', path: `${NET}/account/disconnect`, status: 204, handler: disconnect },
  { op: 'exclusionsNetworkApplianceUmbrellaDomains', method: 'PUT', path: `${NET}/domains/exclusions`, handler: exclusions },
  { op: 'addNetworkApplianceUmbrellaPolicies', method: 'POST', path: `${NET}/policies/add`, status: 200, handler: addPolicy },
  { op: 'removeNetworkApplianceUmbrellaPolicies', method: 'POST', path: `${NET}/policies/remove`, status: 204, handler: removePolicy },
  { op: 'protectionNetworkApplianceUmbrella', method: 'PUT', path: `${NET}/protection`, handler: protection },
  { op: 'getOrganizationIntegrationsDeployable', path: `${ORG}/integrations/deployable`, handler: deployable },
  { op: 'getOrganizationIntegrationsDeployed', path: `${ORG}/integrations/deployed`, handler: deployed },
  { op: 'getOrganizationIntegrationsXdrNetworks', path: `${ORG}/integrations/xdr/networks`, handler: xdrList },
  { op: 'disableOrganizationIntegrationsXdrNetworks', method: 'POST', path: `${ORG}/integrations/xdr/networks/disable`, status: 200, handler: setXdr(false) },
  { op: 'enableOrganizationIntegrationsXdrNetworks', method: 'POST', path: `${ORG}/integrations/xdr/networks/enable`, status: 200, handler: setXdr(true) },
  { op: 'getOrganizationSpacesIntegrateStatus', path: `${ORG}/spaces/integrate/status`, sample: { org: 1 }, handler: spacesStatus },
  { op: 'removeOrganizationSpacesIntegration', method: 'POST', path: `${ORG}/spaces/integration/remove`, status: 200, sample: { org: 1 }, handler: removeSpaces },
];
