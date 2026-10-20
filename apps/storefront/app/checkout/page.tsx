import { InfoPage } from '../../components/info-page';
import { CheckoutForm } from '../../components/checkout-form';

export default function Checkout() { return <InfoPage eyebrow="RESEARCH CHECKOUT" title="Review your order."><p>Confirm your research-use acknowledgement and review the materials before preparing a mock payment request.</p><CheckoutForm /></InfoPage>; }
