import { WalletPageFrame } from '../../../../components/wallet/ui';
import { SendFlow } from '../../../../components/wallet/send-flow';

export const metadata = { title: 'Send Funds | Helix & Field' };

export default function SendPage() {
  return <WalletPageFrame eyebrow="SEND FUNDS" title="Send funds."><SendFlow /></WalletPageFrame>;
}
