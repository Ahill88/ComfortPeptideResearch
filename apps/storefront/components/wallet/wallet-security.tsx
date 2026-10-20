'use client';

import { useState } from 'react';
import { Download, ShieldCheck, Trash2 } from 'lucide-react';
import { useWallet } from './wallet-provider';
import { ConfirmDialog } from './confirm-dialog';
import { buttonClass, cardClass, eyebrowClass, Notice, SANDBOX_NOTE } from './ui';
import { errorMessage } from '../../lib/wallet/api';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="grid gap-1 py-4 sm:grid-cols-[160px_1fr] sm:gap-4"><dt className="text-xs font-semibold text-slate-600">{label}</dt><dd className="text-sm leading-7">{children}</dd></div>;
}

export function WalletSecurityPanel() {
  const { provider, signer, deleteSandboxWallet } = useWallet();
  const [exportError, setExportError] = useState<string | null>(null);

  const download = async () => {
    if (!signer) return;
    try {
      const file = await signer.exportRecovery();
      const url = URL.createObjectURL(new Blob([file.content], { type: file.mimeType }));
      const link = document.createElement('a');
      link.href = url; link.download = file.filename;
      document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportError(null);
    } catch (error) { setExportError(errorMessage(error, 'Export failed.')); }
  };

  return <section aria-labelledby="security-heading" className={cardClass}>
    <ShieldCheck className="text-slate-600" size={21} aria-hidden="true" />
    <p className={`${eyebrowClass} mt-4`}>SECURITY AND OWNERSHIP</p>
    <h2 id="security-heading" className="mt-3 text-3xl tracking-tight">Where the key lives.</h2>
    <dl className="mt-5 divide-y divide-silver border-y border-silver">
      <Row label="Wallet provider">{provider.label}<span className="ml-2 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800">SANDBOX</span></Row>
      <Row label="Custody"><b>Browser-held (sandbox).</b> The platform&apos;s servers never receive or store your private key; it is generated and used in this browser. It is stored unencrypted in browser storage, so any script running on this page (for example through a cross-site-scripting flaw) could read it.</Row>
      <Row label="Key location">{provider.keyLocation}</Row>
      <Row label="Recovery / export">In this sandbox the key is stored in this browser. Clearing browser data without exporting loses access. There is no server-side recovery and this release has no key import, so an exported file is a backup you hold, not something this site can restore.</Row>
      <Row label="Delegated permissions"><b>Not enabled.</b> <span className="text-slate-600">Every purchase asks for your signature one checkout at a time. Standing spend permissions are off by default and not available in this release.</span></Row>
    </dl>
    <p className="mt-4 text-xs leading-6 text-slate-600">{SANDBOX_NOTE} No provider-managed wallet (such as Privy) is configured or integrated.</p>
    <div className="mt-5 flex flex-wrap gap-3">
      <ConfirmDialog
        trigger={<button type="button" className={buttonClass}><Download size={14} aria-hidden="true" />Export recovery file</button>}
        title="Export your sandbox key"
        description={<><p>The file contains your <b>private key</b>. Anyone who has it controls this wallet. Do not share it, upload it, or paste it into any website.</p><p>It is generated in your browser and is not sent anywhere by this page. This is a devnet sandbox key and must not be reused for real funds.</p></>}
        confirmLabel="Download key file" onConfirm={download} />
      <ConfirmDialog
        danger requiredText="DELETE"
        trigger={<button type="button" className={`${buttonClass} border-red-200 text-red-800 hover:bg-red-50`}><Trash2 size={14} aria-hidden="true" />Delete sandbox wallet</button>}
        title="Delete sandbox wallet?"
        description={<><p><b>This is irreversible.</b> The key is removed from this browser and the platform has no copy. Any USDC or SOL at this address becomes inaccessible unless you exported the key first, and this release cannot import an exported key.</p><p>A new key would have a different address. The wallet service links one address per account, so it will refuse the new address while this one is linked; balances and payments would then stay disabled for this account.</p></>}
        confirmLabel="Delete permanently" onConfirm={deleteSandboxWallet} />
    </div>
    {exportError ? <div className="mt-4"><Notice tone="error">{exportError}</Notice></div> : null}
  </section>;
}
