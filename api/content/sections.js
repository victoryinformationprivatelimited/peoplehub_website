// The proposal's written sections. Each has a default text; a partner (or Victory) can replace the text for their own proposals.
//
// Text format (kept simple on purpose): a blank line starts a new paragraph; a line starting "- " is a bullet;
// a line starting "## " is a small heading; **bold** is bold. Placeholders in double braces are filled in per proposal:
//   {{client}} {{company}} {{employees}} {{date}} {{validity}} {{ref}}
//
// kind "text"      = the words above, editable.
// kind "generated" = built from the quote (prices, modules, users); cannot be edited here.
// styles           = which proposal styles include it: summary, standard, comprehensive.

const S = 'summary', ST = 'standard', C = 'comprehensive';
const ALL = [S, ST, C], STD = [ST, C], COMP = [C];

const SECTIONS = [
  { key: 'exec', part: 'The case', title: 'Executive summary', kind: 'generated', styles: ALL },
  { key: 'about', part: 'The case', title: 'About Victory Information', kind: 'text', styles: STD,
    body: `Victory Information (Pvt) Ltd is a Sri Lankan software company with more than ten years of experience and over 600 clients across the island. Our engineers, designers and HR specialists work in-house, so the people who build PeopleHub are the same people who support it.

Alongside PeopleHub HRIS we build and support time and attendance, access control, point of sale, inventory and student management systems.

## Our mission
To bring the best human resource software and service to Sri Lanka, backed by a well-trained team that makes sure every customer is satisfied with both the software and the service behind it.

## Our vision
To be the leading human resource solutions provider in Sri Lanka, with consistent, customer-focused systems that make HR management effective across every industry.

## Why clients work with us
- Over ten years of trust, with 600+ clients in every major industry.
- An in-house team of engineers, designers and HR domain specialists, not only implementers.
- A record of delivering reliable, cost-effective software quickly.` },
  { key: 'challenge', part: 'The case', title: 'The modern HR challenge', kind: 'text', styles: COMP,
    body: `Human resources has moved from administration to a strategic role. {{client}} needs real-time visibility of its workforce, decisions backed by data, a good experience for every employee and an HR team that is not buried in paperwork.

Yet most organisations still wrestle with the same obstacles:
- Employee data scattered across spreadsheets and separate systems.
- Manual, paper-based HR processes.
- Payroll delays and calculation errors.
- Compliance and audit risk.
- Low employee engagement.
- Limited workforce reporting and analytics.
- Slow answers to employee requests.
- A heavy administrative load on the HR team.

Replacing that patchwork of spreadsheets, separate tools and manual approvals with one connected system is what PeopleHub is built to do.` },
  { key: 'solution', part: 'The case', title: 'Introducing PeopleHub', kind: 'text', styles: STD,
    body: `PeopleHub is a cloud-ready Human Resource Information System that helps {{client}} manage the whole employee lifecycle, from hiring to exit, in one place. It is built on modern Microsoft technology and designed to grow with the organisation.

## What {{client}} can expect
- Better HR efficiency and less administrative work.
- Stronger compliance and governance.
- Decisions based on live workforce data.
- A better experience for employees and managers.
- A platform that supports growth.` },
  { key: 'capabilities', part: 'The platform', title: 'The PeopleHub platform', kind: 'generated', styles: STD },
  { key: 'scope', part: 'Your solution', title: 'Your solution', kind: 'generated', styles: ALL },
  { key: 'tech', part: 'The platform', title: 'Technology, security and integration', kind: 'text', styles: STD,
    body: `PeopleHub is delivered as a multi-tenant software-as-a-service platform. Each organisation has its own isolated tenant, with separate data, configuration, roles and branding, running on shared cloud infrastructure that scales with the workforce. Upgrades, patches and security updates are applied centrally with no downtime for your team.

## Technology
- A cloud-ready platform on resilient, scalable infrastructure
- .NET Core application backend
- React web front end
- PostgreSQL data platform

## Integration
PeopleHub connects with ERP and accounting systems, payroll systems, biometric attendance devices and other third-party applications.

## Security and governance
- Role-based access control across every module and action, with a central permission matrix.
- Single sign-on (SSO) with Google and Microsoft accounts.
- Multi-factor authentication (MFA) at sign-in.
- Audit logs of sensitive operations, with compliance reporting.
- Encryption of sensitive employee and financial data in storage and in transit.` },
  { key: 'why', part: 'The platform', title: 'Why organisations choose PeopleHub', kind: 'text', styles: COMP,
    body: `- Complete employee lifecycle management in one system.
- A flexible integration framework.
- One platform for HR, engagement and productivity.
- Enterprise-grade security.
- A strong self-service experience for employees and managers.
- Cloud-native architecture.
- Built-in collaboration and communication tools.
- Scales as the organisation grows.
- Workforce analytics and insight.
- Dedicated local expertise and support.` },
  { key: 'compare', part: 'The platform', title: 'How PeopleHub compares', kind: 'text', styles: COMP,
    body: `Organisations in Sri Lanka usually weigh a local specialist, a regional cloud suite and a global enterprise platform. These are the points we find matter most in practice.

## What sets PeopleHub apart
- Sri Lankan statutory payroll ready out of the box, with no localisation project.
- Native integration with biometric devices (ZKTeco with WDMS), and the devices themselves can come from the same supplier.
- A local, in-house engineering team in Colombo, so client-specific changes are handled directly.
- A full talent suite (recruitment, learning, succession and performance) in the same product.
- Typically live in weeks, with on-site support in Sri Lanka included.

Please check any comparison with other vendors directly with them; products and capabilities change over time.` },
  { key: 'industries', part: 'The platform', title: 'Industries we serve', kind: 'text', styles: COMP,
    body: `PeopleHub adapts to the way each industry works. We support organisations in manufacturing, financial services, retail, healthcare, hospitality, education, logistics, technology, government and other institutions.` },
  { key: 'engage', part: 'The evidence', title: 'Where we engage', kind: 'text', styles: COMP,
    body: `Victory Information delivers and supports PeopleHub from two territories. Sri Lanka is our head office and engineering base, in Mount Lavinia, where product engineering, implementation, data migration and the support desk operate. Fiji is our Pacific territory, serving organisations in that region.

We also serve clients in Ireland and the United States through partners, with implementation and support coordinated by the head-office team. Because PeopleHub is a cloud-ready platform, the same team can support {{client}} wherever its sites and people are, and multi-country and multi-currency settings are built into the platform.` },
  { key: 'results', part: 'The evidence', title: 'Results and references', kind: 'text', styles: COMP,
    body: `The figures below are indicative and come from past engagements; results depend on each organisation's starting point.

## Case study: Fiji's largest supermarket chain
A multi-store retail network with a shift-based workforce and a monthly payroll of 1,200 records.
- Before: attendance came from separate biometric devices at each store and was reconciled in Excel. The payroll run took four working days, followed by corrections, and leave was tracked on paper.
- After PeopleHub: every store syncs to one attendance record, payroll runs in under one working day with an audit trail, and employees check balances and apply for leave from the self-service portal.
- Outcome: about 75% less time on the monthly payroll run, around 90% fewer attendance disputes, six weeks from kick-off to go-live, and the equivalent of two full-time HR administrators released.

## Further references
- Financial services: a licensed finance company with 400 staff brought field-officer attendance and multi-level leave approval into one workflow.
- Hospitality: a resort group with 650 staff across four properties runs rostering and service-charge distribution from a single attendance record.
- Healthcare: a private hospital with 900 staff tracks 24-hour shift patterns and clinical credential expiry against the employee master.
- Logistics: a freight operator with 300 staff across depots calculates driver duty hours and overtime automatically each cycle.` },
  { key: 'roi', part: 'The evidence', title: 'The business case', kind: 'text', styles: COMP,
    body: `This is an indicative model, not a quotation. It is based on administrative hours recovered, payroll correction cycles avoided and less manual reconciliation. A costed model for {{client}} is produced during discovery.

## Typical effect by size
- 150 employees: about 420 HR administration hours recovered a year, payroll processing from 2 days to 0.5 days a month, and around a quarter of one full-time role released. Typical payback on implementation: 12 to 18 months.
- 500 employees: about 1,400 hours recovered, payroll from 3 days to 0.5 days, and around three quarters of a full-time role released. Typical payback: 8 to 12 months.
- 1,500 employees: about 4,200 hours recovered, payroll from 4 days to 1 day, and about two and a half full-time roles released. Typical payback: 6 to 9 months.

## From capital cost to operating cost
Subscription pricing replaces a large upfront investment with a predictable monthly cost that grows with headcount, with no server purchase and no licence true-up.

Compliance penalties avoided, lower attrition from faster HR service and management time saved through self-service reporting are real benefits that are not included in the figures above.` },
  { key: 'implementation', part: 'Delivery', title: 'Implementation, training and support', kind: 'text', styles: STD,
    body: `Victory Information follows a structured approach so that PeopleHub is configured properly, adopted by every user and supported after go-live.

## The stages
- Discovery and requirements (about 2 weeks): workshops to confirm the organisation structure, modules in scope, integrations and success measures.
- Statement of work and solution design (about 1 week): the findings become a signed scope, design, milestone plan and effort estimate.
- Configuration and data migration (about 5 weeks): roles, workflows, pay components, leave policies, and migration of the employee master data.
- Integration and testing (about 3 weeks): biometric devices, payroll and other systems are connected and tested.
- Acceptance testing and training (about 2 weeks): testing with key stakeholders, HR administrator training and sessions for managers and employees.
- Go-live and hypercare (about 3 weeks): cutover, a parallel run if needed, and close support in the first weeks.
- Ongoing support: standard support and maintenance, with regular reviews and enhancements.

A typical deployment for a mid-sized organisation takes about 16 weeks. The actual timeline is confirmed at the end of discovery and depends on the modules in scope, the number of integrations and how ready the data is. Stages overlap by design, and a detailed plan is issued with the statement of work.

## Hypercare after go-live
A dedicated hypercare period covers system monitoring and stabilisation, and priority issue resolution.` },
  { key: 'requirements', part: 'Delivery', title: 'Software and hardware requirements', kind: 'text', styles: COMP,
    body: `PeopleHub runs on standard IT infrastructure and is delivered from the cloud.

## Computers for HR and administrators
- Processor: dual-core 2.0 GHz minimum, quad-core 2.5 GHz or better recommended.
- Memory: 4 GB minimum, 8 GB recommended.
- Browser: Chrome, Firefox or Edge version 110 or later (the latest version is recommended).
- Internet: 2 Mbps minimum, 5 Mbps or more recommended.

## Computers for employee self-service
The same as above.

## Mobile devices
- Android 8.0 or later, or iOS 12 or later (Android 12 or later, or iOS 16 or later is recommended).
- A 3G, 4G or Wi-Fi connection (4G or stable Wi-Fi is recommended).

## Hardware, where used
- Biometric attendance devices: ZKTeco devices with the WDMS option are recommended for accurate real-time attendance and integration with PeopleHub.
- Networked printers: for payslips, letters and reports, with network connectivity and compatibility with PeopleHub output.` },
  { key: 'security', part: 'Delivery', title: 'Data security and service levels', kind: 'text', styles: STD,
    body: `## Identity and access
- Single sign-on (SSO) with Google and Microsoft accounts, so people use the sign-in they already have and leavers lose access in one place.
- Multi-factor authentication (MFA) adds a second check at sign-in, and can be required for administrators or for everyone.
- An enforced password policy for accounts that sign in with a password.
- Role-based access control gives each person only the permissions their role needs, managed in a central permission matrix.

## Audit logs
- Every create, update and delete is recorded with the user, the date and time, and the before and after values.
- Sensitive actions such as permission changes, payroll processing and changes to employee records are traceable to a named person.
- Audit logs support compliance reviews and investigations, and are kept for the period you configure.

## Data security
- Sensitive data is encrypted in storage and in transit, and credentials are stored encrypted.
- Each organisation has its own isolated tenant, with separate data, configuration and roles.
- Database credentials are encrypted, and sensitive data is encrypted in storage and transit.
- All integrations and external connections use secure API authentication.

## Availability
Victory Information commits to 99% uptime for the PeopleHub platform, excluding scheduled maintenance windows.

## Support
A service level agreement defines support and response times for technical issues, and a clear escalation process makes sure critical issues are resolved quickly.` },
  { key: 'cloud', part: 'Delivery', title: 'Cloud architecture and disaster recovery', kind: 'text', styles: COMP,
    body: `PeopleHub is a cloud-ready platform, built as a resilient, high-availability design.

## How the environment is laid out
- Edge layer (Cloudflare): DNS, TLS, DDoS protection, web application firewall and caching.
- Firewall: perimeter filtering and intrusion prevention, with only the required ports open.
- Load balancers: spread traffic across redundant servers with health checks and failover.
- Front-end servers: the web and mobile application tier.
- Back-end servers: business logic, payroll and attendance processing.
- Database servers: a primary database with a high-availability replica, encrypted at rest.
- Device server (WDMS): syncs biometric terminals to the back end over a secured channel.
- Backups: local backups at the client site and geo-redundant backups in another region.

## Security practices
- Network: all traffic passes the web application firewall and a managed firewall, and administrative access is limited to approved addresses over VPN.
- Encryption: TLS 1.2 or later in transit and AES-256 at rest, including backups.
- Access: least-privilege roles, enforced password policy, multi-factor authentication for administrators and full audit logging.
- Patching: regular patching on hardened server images.
- Monitoring: continuous availability and performance monitoring with alerts, and central security logs.

## Backup and disaster recovery
- Automated daily database backups kept for at least one month.
- Weekly backups kept for one to three months, and monthly backups for at least three months.
- Geo-redundant backup storage protects against regional outages.
- Backups are encrypted and restore-tested, with recovery point and recovery time objectives confirmed during discovery.

## Data archival
Retention is configurable and finalised with you. Typical settings are payroll data online for at least 5 years, attendance data for at least 2 years and audit logs for at least 6 months, or longer where required.` },
  { key: 'customisation', part: 'Your solution', title: 'Customisation and integration', kind: 'generated', styles: ALL },
  { key: 'invest', part: 'Commercials', title: 'Investment', kind: 'generated', styles: ALL },
  { key: 'payment', part: 'Commercials', title: 'Payment terms', kind: 'generated', styles: STD },
  { key: 'terms', part: 'Commercials', title: 'Terms and conditions', kind: 'text', styles: ALL,
    body: `- This proposal, including all pricing, is valid for {{validity}} days from {{date}} unless Victory Information extends it in writing.
- Pricing covers the standard version of PeopleHub. Custom development or changes beyond the agreed scope are estimated and billed separately at the hourly rates shown in this proposal, agreed in writing before work begins.
- All prices are in US dollars and are all-inclusive. There are no other taxes or hidden costs.
- Notification charges (SMS, WhatsApp and email) are billed by actual usage, and only for the channels you have activated. Extra storage is billed at actual usage.
- Statutory payroll and compliance settings follow the rules of the client's country of operation at the time of implementation, unless a specific jurisdiction is stated in the order form.
- PeopleHub can integrate with existing biometric attendance devices after compatibility is checked. Incompatible devices can be supplied by Victory Information for an additional fee.
- A non-disclosure agreement is available and can be signed before the engagement starts.
- Employee master data is uploaded using a standard Excel template provided before implementation.
- Payments are due within 7 days of invoice. Extra customisation, hardware or modules beyond the agreed scope are invoiced separately once approved.
- This proposal is not a binding agreement. A formal order form or service agreement confirms scope, pricing and terms before the project starts.` },
  { key: 'team', part: 'Commercials', title: 'Project steering team', kind: 'text', styles: COMP,
    body: `The core team below oversees and delivers the engagement for {{client}}, supported by further implementation and support engineers as needed.

- Amila Pathum: Founder and Managing Director, 15+ years
- Benton Samuel: Director, 35+ years
- Shalika Hewawickrama: Lead HR Consultant, 25+ years
- Dasun K Lokuhetti: IT and Cyber Security Consultant, 17+ years
- Ilmu Sariffodeen: Associate HR Consultant, 15+ years
- Nethmi Hinidumage: Project Manager, 5+ years
- Haritha Munasinghe: Tech Lead and Senior Software Engineer, 10+ years
- Malith Jayasinghe: Senior Implementation Engineer, 10+ years
- Bhanuka Senevirathna: Senior Support Engineer, 10+ years` },
  { key: 'partner', part: 'Commercials', title: 'Why partner with us', kind: 'text', styles: COMP,
    body: `Choosing an HRIS is choosing a long-term technology partner. Victory Information brings more than a decade of Sri Lankan enterprise software experience to the delivery and support of PeopleHub.

- 600+ clients across manufacturing, financial services, hospitality, healthcare, government and more, with delivery in Sri Lanka and Fiji.
- An in-house engineering team, so customisation and support are faster and do not depend on a third party.
- One partner for the whole HR technology stack: PeopleHub HRIS, biometric attendance devices and access control.
- Local presence and support, based in Mount Lavinia, with direct phone, email and on-site help.
- A proven development process that has delivered reliable, cost-effective software for over ten years.` },
  { key: 'next', part: 'Commercials', title: 'Next steps', kind: 'text', styles: STD,
    body: `We would welcome the chance to take this proposal further with {{client}}.

- Discovery call: a short session with your HR and IT stakeholders to walk through the proposal and confirm priority modules.
- Live demonstration: a hands-on session with PeopleHub set up around your organisation.
- Scoping and final quotation: a detailed scoping exercise that produces the itemised commercial offer and the implementation timeline.
- Agreement and kick-off: contract signing, followed by project kick-off as described in the implementation section.

## What happens in the first week
- A project manager is assigned and the kick-off call is booked.
- Discovery workshop dates are confirmed with HR and IT.
- The employee data template is issued for completion.
- The biometric device inventory and compatibility check begin.
- A sandbox tenant is set up for your team.
- A non-disclosure agreement is signed if it is not already in place.` },
  { key: 'accept', part: 'Commercials', title: 'Acceptance', kind: 'generated', styles: ALL },
  { key: 'contact', part: 'Commercials', title: 'Contact us', kind: 'text', styles: STD,
    body: `Thank you for considering PeopleHub HRIS. We look forward to discussing how it can help {{client}} manage its workforce with confidence.

## Victory Information (Pvt) Ltd
No 150, Templers Road, Mount Lavinia, Sri Lanka
Email: info@victoryinformation.lk and sales@victoryinformation.lk
Phone: +94 76 744 4999
Web: victoryinformation.lk and peoplehub.biz` },
];

const STYLES = [
  { id: 'summary', name: 'Summary', blurb: 'A short proposal: summary, your solution, customisation, investment, terms and acceptance.' },
  { id: 'standard', name: 'Standard', blurb: 'The full story without the long reference material: platform, implementation, security, commercials and next steps.' },
  { id: 'comprehensive', name: 'Comprehensive', blurb: 'Everything: all of Standard plus the business case, references, requirements, architecture and team.' },
];

const byKey = Object.fromEntries(SECTIONS.map((s) => [s.key, s]));

module.exports = { SECTIONS, STYLES, byKey };
