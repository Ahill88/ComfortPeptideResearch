import { InfoPage } from '../../components/info-page';
import { CheckoutForm } from '../../components/checkout-form';

export default function Checkout() { return <InfoPage eyebrow="RESEARCH CHECKOUT" title="Review your order."><p>Review current prices, shipping, tax and availability, then confirm your research-use acknowledgement before continuing to payment.</p><CheckoutForm /></InfoPage>; }
