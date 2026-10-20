import { WalletPageFrame } from '../../../../components/wallet/ui';
import { AddCreditsFlow } from '../../../../components/wallet/add-credits-flow';

export const metadata = { title: 'Add Credits | Helix & Field' };

export default function AddCreditsPage() {
  return <WalletPageFrame eyebrow="ADD CREDITS" title="Add credits."><AddCreditsFlow /></WalletPageFrame>;
}
