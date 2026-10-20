import { redirect } from 'next/navigation';

/** Short alias: the wallet lives under the account area. */
export default function WalletAlias() {
  redirect('/account/wallet');
}
