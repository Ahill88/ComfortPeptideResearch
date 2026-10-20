import Link from 'next/link';
import { InfoPage } from '../../components/info-page';

export const metadata = { title: 'Privacy | Helix & Field' };

export default function Privacy() {
  return <InfoPage eyebrow="Preview policy" title="Privacy, clearly stated."><p>This is a preliminary privacy notice for the storefront preview, not a finalized policy for a live commercial service. Data handling details must be reviewed and confirmed before launch.</p><section><h2>Your research bag</h2><p>The storefront stores selected product identifiers and quantities in your browser’s local storage so your bag can persist between visits. You can remove items from the bag or clear this site’s browser storage.</p></section><section><h2>Mock checkout</h2><p>The current mock checkout checks the email, shipping address, and research acknowledgement entered in the form locally. Preparing its mock payment request does not place an order or transfer funds. Use test details when exploring the preview.</p></section><section><h2>Details still pending</h2><p>A complete policy must identify the responsible operator and confirm account-data handling, service providers, retention periods, analytics or cookies, applicable rights, and a verified privacy contact. This preview does not make commitments about those unconfirmed details.</p></section><section><h2>Questions</h2><p>See the <Link href="/contact" className="font-medium text-[#0B1220] underline">contact page</Link> for available inquiry options. A dedicated privacy contact has not yet been published in this notice.</p></section></InfoPage>;
}
