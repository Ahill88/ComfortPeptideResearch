import { WalletPageFrame } from '../../../components/wallet/ui';
import { WalletDashboard } from '../../../components/wallet/wallet-dashboard';

export const metadata = { title: 'Research Wallet | Helix & Field' };

export default function WalletPage() {
  return <WalletPageFrame eyebrow="RESEARCH WALLET" title="Research Credits."><WalletDashboard /></WalletPageFrame>;
}
