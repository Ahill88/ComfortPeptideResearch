export interface WalletSection {
  slug: string;
  href: string;
  label: string;
  title: string;
  description: string;
}

export const WALLET_SECTIONS: WalletSection[] = [
  { slug: 'directory', href: '/wallets', label: 'Wallet directory', title: 'Wallet directory', description: 'Customer wallets by provider and network. Addresses are public; the platform holds no keys.' },
  { slug: 'balances', href: '/wallets/balances', label: 'Credit display balances', title: 'Credit display balances', description: 'Latest balance snapshot observed on chain for each wallet.' },
  { slug: 'funding', href: '/wallets/funding', label: 'Funding activity', title: 'Funding activity', description: 'On-ramp funding intents and their provider status.' },
  { slug: 'payment-intents', href: '/wallets/payment-intents', label: 'Payment intents', title: 'Payment intents', description: 'Order payment rows and purchase transactions prepared for customers to sign.' },
  { slug: 'verification', href: '/wallets/verification', label: 'On-chain verification', title: 'On-chain verification', description: 'Crypto transactions and their verification status, filterable by status.' },
  { slug: 'settlements', href: '/wallets/settlements', label: 'Settlement reporting', title: 'Settlement reporting', description: 'Finalized purchase transactions aggregated per UTC day.' },
  { slug: 'pending-orders', href: '/wallets/pending-orders', label: 'Pending orders', title: 'Pending orders', description: 'Orders awaiting payment.' },
  { slug: 'failed', href: '/wallets/failed', label: 'Failed transactions', title: 'Failed transactions', description: 'Failed and expired transactions with the recorded failure reason.' },
  { slug: 'reconciliation', href: '/wallets/reconciliation', label: 'Reconciliation', title: 'Reconciliation', description: 'Transaction counts per status and the age of the oldest submitted transaction.' },
  { slug: 'providers', href: '/wallets/providers', label: 'Provider status', title: 'Provider status', description: 'Provider configuration state and feature flags. Secret values are never shown.' },
];
