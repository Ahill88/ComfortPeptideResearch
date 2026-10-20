import { eyebrowClass } from './ui';

const disclosures = [
  'When a quote is a real MoonPay quote, MoonPay is the third party that performs identity and payment checks and sets its own fees; we do not control, estimate or guarantee them. A quote marked SANDBOX involves no MoonPay purchase, no identity check and no real money.',
  'Network fees are paid in SOL from your own wallet, separately from any USDC amount.',
  'Blockchain transfers may be irreversible. Check every address and amount before you sign.',
  'The platform servers hold no key for your wallet and cannot sign for you. Each payment or transfer is signed individually in this browser with the sandbox key, which is stored in this browser and is lost if browser data is cleared without exporting it.',
  'Research Credits are a display unit equal to whole USDC available in your wallet. They are not a separate balance and are not issued by the platform.',
];

export function WalletDisclosures() {
  return <section aria-labelledby="wallet-disclosures" className="rounded-2xl border border-silver bg-ice/10 p-6 sm:p-8">
    <p className={eyebrowClass}>DISCLOSURES</p>
    <h2 id="wallet-disclosures" className="mt-3 text-2xl tracking-tight">Read before you add or move funds.</h2>
    <ul className="mt-5 space-y-3 text-sm leading-7 text-slate-700">{disclosures.map((d) => <li className="flex gap-3" key={d}><span aria-hidden="true" className="mt-3 h-1 w-1 shrink-0 rounded-full bg-slate-500" /><span>{d}</span></li>)}</ul>
  </section>;
}
