// Static templates for the simulated organizations. Topology is fixed; the seed
// decides IDs, serials, MACs, client identities and every time-varying value.

export const MODELS = {
  MX250: { productType: 'appliance', firmware: 'wired-18-211-2' },
  MX85: { productType: 'appliance', firmware: 'wired-18-211-2' },
  MX75: { productType: 'appliance', firmware: 'wired-18-211-2' },
  MX68: { productType: 'appliance', firmware: 'wired-18-211-2' },
  MX67: { productType: 'appliance', firmware: 'wired-18-211-2' },
  'MS390-48UX': { productType: 'switch', firmware: 'switch-17-1-4', ports: 48, uplinks: 8, accessSpeed: '1 Gbps', uplinkSpeed: '10 Gbps', psus: 2 },
  'MS250-48FP': { productType: 'switch', firmware: 'switch-17-1-4', ports: 48, uplinks: 4, accessSpeed: '1 Gbps', uplinkSpeed: '10 Gbps' },
  'MS130-48P': { productType: 'switch', firmware: 'switch-17-1-4', ports: 48, uplinks: 4, accessSpeed: '1 Gbps', uplinkSpeed: '10 Gbps' },
  'MS130-24P': { productType: 'switch', firmware: 'switch-17-1-4', ports: 24, uplinks: 4, accessSpeed: '1 Gbps', uplinkSpeed: '10 Gbps' },
  'MS120-8LP': { productType: 'switch', firmware: 'switch-17-1-4', ports: 8, uplinks: 2, accessSpeed: '1 Gbps', uplinkSpeed: '1 Gbps' },
  CW9166I: { productType: 'wireless', firmware: 'wireless-31-1-6', watts: 24, speed: '5 Gbps', bands: ['2.4', '5', '6'] },
  MR46: { productType: 'wireless', firmware: 'wireless-31-1-6', watts: 18, speed: '2.5 Gbps', bands: ['2.4', '5'] },
  MR36: { productType: 'wireless', firmware: 'wireless-31-1-6', watts: 13, speed: '1 Gbps', bands: ['2.4', '5'] },
  MR78: { productType: 'wireless', firmware: 'wireless-31-1-6', watts: 15, speed: '1 Gbps', bands: ['2.4', '5'] },
  MV22: { productType: 'camera', firmware: 'camera-6-3', watts: 7, speed: '1 Gbps' },
  MV72: { productType: 'camera', firmware: 'camera-6-3', watts: 11, speed: '1 Gbps' },
};

export const SERIAL_PREFIX = { appliance: 'Q2PN', switch: 'Q2HP', wireless: 'Q3AC', camera: 'Q2FV' };
export const DEVICE_OUI = { appliance: 'e0:55:3d', switch: 'e0:cb:bc', wireless: '0c:8d:db', camera: '34:56:fe' };

// Link profiles: baseline RTT to 8.8.8.8 in ms, and loss/latency behaviour.
export const ISPS = {
  fiber: { provider: 'Metro Fiber', latency: 6, jitter: 0.6, evening: 1 },
  cable: { provider: 'Cable Co', latency: 15, jitter: 2.5, evening: 9 },
  dsl: { provider: 'Telco DSL', latency: 27, jitter: 3.5, evening: 6 },
};

export const VLANS = {
  1: 'Management',
  5: 'Servers',
  10: 'Corporate',
  20: 'Voice',
  30: 'Guest',
  40: 'IoT',
  50: 'Scanners',
  60: 'POS',
};

export const SSIDS = {
  corp: { name: 'Acme-Corp', authMode: '8021x-radius', vlan: 10, auth: '8021x' },
  guest: { name: 'Acme-Guest', authMode: 'open', vlan: 30, auth: 'splash', splashPage: 'Click-through splash page', nat: true },
  iot: { name: 'Acme-IoT', authMode: 'psk', vlan: 40, auth: 'wpa' },
  scanners: { name: 'Acme-Scanners', authMode: 'psk', vlan: 50, auth: 'wpa' },
};

// kbps is the average rate while connected; curve shapes it over the local day.
export const KINDS = {
  laptop: { schedule: 'office', kbps: 380, up: 0.22, sigma: 0.7, burst: 0.012, wan: 0.9, curve: 'work', wiredShare: 0.3, ssid: 'corp', vlan: 10 },
  phone: { schedule: 'office', kbps: 45, up: 0.18, sigma: 0.8, burst: 0.01, wan: 0.95, curve: 'work', ssid: 'corp', vlan: 10 },
  deskPhone: { schedule: 'always', kbps: 4, up: 0.5, sigma: 0.3, wan: 0.6, curve: 'calls', wired: true, vlan: 20 },
  printer: { schedule: 'always', kbps: 1.5, up: 0.3, sigma: 1.0, wan: 0.1, curve: 'work', wired: true, vlan: 10 },
  nas: { schedule: 'always', kbps: 150, up: 0.95, sigma: 0.25, wan: 1, curve: 'backup', wired: true, vlan: 5 },
  confTv: { schedule: 'always', kbps: 8, up: 0.4, sigma: 0.4, wan: 0.95, curve: 'meetings', ssid: 'corp', vlan: 10 },
  guest: { schedule: 'guest', kbps: 220, up: 0.12, sigma: 0.9, burst: 0.02, wan: 1, curve: 'flat', ssid: 'guest', vlan: 30 },
  iot: { schedule: 'always', kbps: 1, up: 0.6, sigma: 0.5, wan: 1, curve: 'flat', ssid: 'iot', vlan: 40 },
  scanner: { schedule: 'shift', kbps: 12, up: 0.4, sigma: 0.6, wan: 0.7, curve: 'flat', ssid: 'scanners', vlan: 50 },
  pos: { schedule: 'always', kbps: 4, up: 0.5, sigma: 0.8, wan: 1, curve: 'retail', wired: true, vlan: 60 },
};

export const CLIENT_PROFILES = {
  laptop: [
    { manufacturer: 'Apple', oui: ['f0:18:98', 'a4:83:e7', '3c:22:fb'], os: 'Mac OS X', prediction: 'MacBook Pro', host: (u) => `MBP-${u}` },
    { manufacturer: 'Dell', oui: ['b0:7b:25', 'd4:81:d7'], os: 'Windows 11', prediction: 'Windows 11', host: (u, r) => `LAPTOP-${r.chars(7, 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789')}` },
    { manufacturer: 'Lenovo', oui: ['54:e1:ad', '98:fa:9b'], os: 'Windows 11', prediction: 'Windows 11', host: (u, r) => `LAPTOP-${r.chars(7, 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789')}` },
    { manufacturer: 'HP', oui: ['3c:52:82', '6c:02:e0'], os: 'Windows 11', prediction: 'Windows 11', host: (u, r) => `DESKTOP-${r.chars(7, 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789')}` },
  ],
  phone: [
    { manufacturer: 'Apple', oui: ['f0:18:98', '3c:22:fb'], os: 'iOS', prediction: 'iPhone', host: (u, r, n) => `${n}s-iPhone`, randomMac: 0.5 },
    { manufacturer: 'Samsung', oui: ['a8:9c:ed', '5c:e8:eb'], os: 'Android', prediction: 'Galaxy', host: (u, r, n) => `Galaxy-${n}`, randomMac: 0.5 },
    { manufacturer: 'Google', oui: ['f4:f5:d8'], os: 'Android', prediction: 'Pixel', host: (u, r, n) => `Pixel-${n}`, randomMac: 0.5 },
  ],
  deskPhone: [{ manufacturer: 'Cisco', oui: ['00:1e:7a', '6c:41:6a'], os: null, prediction: 'IP Phone', host: (u, r, n, mac) => `SEP${mac.replace(/:/g, '').toUpperCase()}` }],
  printer: [
    { manufacturer: 'HP', oui: ['3c:52:82'], os: null, prediction: 'Printer', host: (u, r) => `HP-LaserJet-${r.int(100, 999)}` },
    { manufacturer: 'Brother', oui: ['00:80:77'], os: null, prediction: 'Printer', host: (u, r) => `BRN-${r.chars(6, '0123456789ABCDEF')}` },
  ],
  nas: [{ manufacturer: 'Synology', oui: ['00:11:32'], os: 'Linux', prediction: 'NAS', host: () => 'BACKUP-NAS' }],
  confTv: [{ manufacturer: 'Apple', oui: ['3c:22:fb'], os: 'tvOS', prediction: 'Apple TV', host: (u, r, n, mac, i) => `Conf-Room-${i + 1}` }],
  guest: [
    { manufacturer: null, oui: [], os: 'iOS', prediction: 'iPhone', host: () => null, randomMac: 1 },
    { manufacturer: null, oui: [], os: 'Android', prediction: null, host: () => null, randomMac: 1 },
    { manufacturer: 'Apple', oui: ['a4:83:e7'], os: 'Mac OS X', prediction: 'MacBook Air', host: () => null },
  ],
  iot: [
    { manufacturer: 'Google', oui: ['f4:f5:d8'], os: null, prediction: 'Thermostat', host: (u, r, n, mac, i) => `Thermostat-${i + 1}` },
    { manufacturer: 'Espressif', oui: ['24:0a:c4'], os: null, prediction: null, host: (u, r) => `esp-${r.hex(6)}` },
  ],
  scanner: [{ manufacturer: 'Zebra', oui: ['00:23:68', '94:fb:29'], os: 'Android', prediction: 'Handheld Scanner', host: (u, r, n, mac, i) => `TC52-${String(i + 1).padStart(3, '0')}` }],
  pos: [{ manufacturer: 'Verifone', oui: ['00:0b:4f'], os: null, prediction: 'POS Terminal', host: (u, r, n, mac, i) => `POS-${String(i + 1).padStart(2, '0')}` }],
};

export const FIRST_NAMES = ['Alex', 'Sam', 'Jordan', 'Taylor', 'Casey', 'Riley', 'Morgan', 'Jamie', 'Drew', 'Avery', 'Quinn', 'Cameron', 'Reese', 'Skyler', 'Parker', 'Rowan', 'Emerson', 'Harper', 'Logan', 'Blake', 'Dakota', 'Hayden', 'Jesse', 'Kai'];
export const LAST_NAMES = ['Chen', 'Patel', 'Garcia', 'Nguyen', 'Smith', 'Johnson', 'Kim', 'Lopez', 'Brown', 'Martin', 'Lee', 'Wilson', 'Clark', 'Lewis', 'Walker', 'Young', 'Hall', 'Allen', 'Wright', 'Scott', 'Adams', 'Baker', 'Rivera', 'Singh'];

// sessions: office sites follow business hours, retail keeps store hours, warehouse runs two shifts.
export const ORGS = [
  {
    name: 'Acme Corporation',
    networks: [
      {
        code: 'HQ', name: 'HQ - San Francisco', kind: 'office', tz: 'America/Los_Angeles', address: 'San Francisco, CA, USA', lat: 37.7897, lng: -122.3942, tags: ['hq', 'production'],
        vpn: 'hub', mx: { model: 'MX250', wan: ['fiber', 'cable'] },
        switches: [{ model: 'MS390-48UX', name: 'Core' }, { model: 'MS250-48FP', name: '2F' }, { model: 'MS250-48FP', name: '3F' }],
        aps: { model: 'CW9166I', names: ['2F-01', '2F-02', '2F-03', '2F-04', '2F-05', '3F-01', '3F-02', '3F-03', '3F-04', 'Lobby'] },
        cameras: { model: 'MV22', names: ['Lobby', 'Loading-Dock', 'Server-Room'] },
        ssids: ['corp', 'guest', 'iot'],
        clients: { laptop: 120, phone: 110, deskPhone: 40, printer: 6, nas: 1, confTv: 6, guest: 45, iot: 12 },
      },
      {
        code: 'AUS', name: 'Branch - Austin', kind: 'office', tz: 'America/Chicago', address: 'Austin, TX, USA', lat: 30.2672, lng: -97.7431, tags: ['branch', 'production'],
        vpn: 'spoke', mx: { model: 'MX85', wan: ['fiber', 'cable'] },
        switches: [{ model: 'MS130-24P', name: '01', alerting: true }, { model: 'MS130-24P', name: '02' }],
        aps: { model: 'MR46', names: ['01', '02', '03', '04'] },
        ssids: ['corp', 'guest'],
        clients: { laptop: 35, phone: 30, deskPhone: 12, printer: 2, confTv: 2, guest: 12 },
      },
      {
        code: 'RNO', name: 'Warehouse - Reno', kind: 'warehouse', tz: 'America/Los_Angeles', address: 'Reno, NV, USA', lat: 39.5296, lng: -119.8138, tags: ['warehouse', 'production'],
        vpn: 'spoke', mx: { model: 'MX75', wan: ['cable', 'dsl'] },
        switches: [{ model: 'MS130-48P', name: '01' }, { model: 'MS130-48P', name: '02' }],
        aps: { model: 'MR78', names: ['Dock-01', 'Dock-02', 'Dock-03', 'Aisle-01', 'Aisle-02', 'Office'], flaky: 'Dock-03' },
        cameras: { model: 'MV72', names: ['Yard-1', 'Yard-2', 'Dock-East', 'Dock-West'], dormant: 'Yard-2' },
        ssids: ['corp', 'scanners', 'guest', 'iot'],
        clients: { laptop: 10, phone: [25, 'shift'], scanner: 30, printer: 4, deskPhone: 4, guest: 4, iot: 6 },
      },
      {
        code: 'DEN', name: 'Retail - Denver', kind: 'retail', tz: 'America/Denver', address: 'Denver, CO, USA', lat: 39.7392, lng: -104.9903, tags: ['retail', 'production'],
        vpn: 'spoke', mx: { model: 'MX67', wan: ['cable', 'dsl'] },
        switches: [{ model: 'MS120-8LP', name: '01' }],
        aps: { model: 'MR36', names: ['Floor-01', 'Floor-02'] },
        ssids: ['corp', 'guest'],
        clients: { laptop: [3, 'retail'], phone: [8, 'retail'], pos: 4, printer: 1, guest: 120, iot: 3 },
      },
      {
        code: 'LON', name: 'Remote - London', kind: 'office', tz: 'Europe/London', address: 'London, UK', lat: 51.5074, lng: -0.1278, tags: ['branch', 'emea'],
        vpn: 'spoke', mx: { model: 'MX68', wan: ['fiber'] },
        switches: [{ model: 'MS130-24P', name: '01' }],
        aps: { model: 'MR46', names: ['01', '02', '03'] },
        ssids: ['corp', 'guest'],
        clients: { laptop: 25, phone: 22, deskPhone: 6, printer: 2, confTv: 2, guest: 8 },
      },
    ],
  },
  {
    name: 'Acme Test Lab',
    networks: [
      {
        code: 'TOR', name: 'Lab - Toronto', kind: 'office', tz: 'America/Toronto', address: 'Toronto, ON, Canada', lat: 43.6532, lng: -79.3832, tags: ['lab'],
        aps: { model: 'MR36', names: ['01', '02'] },
        ssids: ['corp', 'iot'],
        clients: { laptop: 6, phone: 5, iot: 8 },
      },
    ],
  },
];

// Traffic analysis catalog. weight is share of WAN bytes; guest skews toward streaming.
export const APPS = [
  { application: 'Microsoft 365', category: 'Productivity', destination: 'outlook.office365.com', protocol: 'TCP', port: 443, weight: 14, guest: 1 },
  { application: 'Zoom', category: 'VoIP & video conferencing', destination: 'zoom.us', protocol: 'UDP', port: 8801, weight: 12, guest: 1 },
  { application: 'Google HTTPS', category: 'Search engines', destination: 'www.google.com', protocol: 'TCP', port: 443, weight: 9, guest: 6 },
  { application: 'YouTube', category: 'Video & music', destination: 'www.youtube.com', protocol: 'TCP', port: 443, weight: 8, guest: 22 },
  { application: 'Slack', category: 'Productivity', destination: 'slack.com', protocol: 'TCP', port: 443, weight: 4, guest: 0 },
  { application: 'Salesforce', category: 'Productivity', destination: 'login.salesforce.com', protocol: 'TCP', port: 443, weight: 3, guest: 0 },
  { application: 'Dropbox', category: 'File sharing', destination: 'www.dropbox.com', protocol: 'TCP', port: 443, weight: 3, guest: 1 },
  { application: 'Windows Update', category: 'Software & anti-virus updates', destination: 'download.windowsupdate.com', protocol: 'TCP', port: 443, weight: 5, guest: 0 },
  { application: 'iCloud', category: 'Online backup', destination: 'www.icloud.com', protocol: 'TCP', port: 443, weight: 4, guest: 5 },
  { application: 'Spotify', category: 'Music', destination: 'open.spotify.com', protocol: 'TCP', port: 443, weight: 3, guest: 6 },
  { application: 'Netflix', category: 'Video & music', destination: 'www.netflix.com', protocol: 'TCP', port: 443, weight: 2, guest: 14 },
  { application: 'Instagram', category: 'Social web & photo sharing', destination: 'www.instagram.com', protocol: 'TCP', port: 443, weight: 2, guest: 12 },
  { application: 'Amazon AWS', category: 'Cloud services', destination: 's3.amazonaws.com', protocol: 'TCP', port: 443, weight: 6, guest: 1 },
  { application: 'Webex', category: 'VoIP & video conferencing', destination: 'webex.com', protocol: 'UDP', port: 9000, weight: 3, guest: 0 },
  { application: 'Miscellaneous secure web', category: 'Miscellaneous', destination: null, protocol: 'TCP', port: 443, weight: 7, guest: 10 },
  { application: 'Miscellaneous web', category: 'Miscellaneous', destination: null, protocol: 'TCP', port: 80, weight: 2, guest: 3 },
  { application: 'DNS', category: 'Network services', destination: '8.8.8.8', protocol: 'UDP', port: 53, weight: 0.4, guest: 0.6 },
  { application: 'Non-web TCP', category: 'Miscellaneous', destination: null, protocol: 'TCP', port: 8443, weight: 1.5, guest: 0.5 },
];

export const IDS_SIGNATURES = [
  { message: 'INDICATOR-SCAN SSH brute force login attempt', signature: '1:19559:9', priority: '2', classification: '5', port: 22, protocol: 'tcp/ip' },
  { message: 'SERVER-APACHE Apache Log4j logging remote code execution attempt', signature: '1:58722:3', priority: '1', classification: '1', port: 443, protocol: 'tcp/ip' },
  { message: 'SERVER-WEBAPP JBoss JMX console access attempt', signature: '1:21516:9', priority: '2', classification: '4', port: 8080, protocol: 'tcp/ip' },
  { message: 'MALWARE-CNC Win.Trojan.Agent outbound connection', signature: '1:44830:2', priority: '1', classification: '3', port: 443, protocol: 'tcp/ip', outbound: true },
  { message: 'POLICY-OTHER Remote non-JavaScript file found in script tag src attribute', signature: '1:32478:4', priority: '3', classification: '2', port: 80, protocol: 'tcp/ip', outbound: true },
  { message: 'OS-WINDOWS Microsoft Windows SMB remote code execution attempt', signature: '1:41978:5', priority: '1', classification: '1', port: 445, protocol: 'tcp/ip' },
  { message: 'PROTOCOL-DNS DNS query amplification attempt', signature: '1:28556:3', priority: '2', classification: '6', port: 53, protocol: 'udp/ip' },
];

export const MALWARE = [
  { canonicalName: 'W32.Trojan.GenericKD::1201', fileType: 'MS_EXE', uri: 'http://downloads.example.net/setup_free.exe' },
  { canonicalName: 'PUA.Win.Adware.Bundler::1201', fileType: 'MS_EXE', uri: 'http://files.example.org/toolbar_installer.exe' },
  { canonicalName: 'Doc.Downloader.Macro::tpd', fileType: 'MS_OFFICE', uri: 'http://share.example.com/invoice_0921.docm' },
];

export const CF_BLOCKS = [
  { category: 'Peer to peer', url: 'http://p2p.example.net/' },
  { category: 'Games', url: 'http://games.example.com/play' },
  { category: 'Malware sites', url: 'http://malicious.example.org/payload' },
  { category: 'Hacking', url: 'http://tools.example.net/crack' },
];
