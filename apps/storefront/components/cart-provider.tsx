'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { canAddToPreviewCart, getProduct, type Product } from '../lib/products';

const STORAGE_KEY = 'helix-field-research-cart';
const MAX_QUANTITY = 99;

type StoredItem = { slug: string; quantity: number };
export type CartItem = { product: Product; quantity: number; lineTotalCents: number };
type CartContextValue = {
  items: CartItem[];
  itemCount: number;
  subtotalCents: number;
  isReady: boolean;
  addItem: (slug: string) => void;
  updateQuantity: (slug: string, quantity: number) => void;
  removeItem: (slug: string) => void;
};

const CartContext = createContext<CartContextValue | null>(null);

function normalizeItems(value: unknown): StoredItem[] {
  if (!Array.isArray(value)) return [];
  const quantities = new Map<string, number>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const { slug, quantity } = item as Partial<StoredItem>;
    if (typeof slug !== 'string' || !canAddToPreviewCart(getProduct(slug)) || typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) continue;
    quantities.set(slug, Math.min(MAX_QUANTITY, (quantities.get(slug) ?? 0) + quantity));
  }
  return Array.from(quantities, ([slug, quantity]) => ({ slug, quantity }));
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [storedItems, setStoredItems] = useState<StoredItem[]>([]);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    try {
      setStoredItems(normalizeItems(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]')));
    } catch {
      setStoredItems([]);
    }
    setIsReady(true);
  }, []);

  useEffect(() => {
    if (isReady) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(storedItems));
  }, [isReady, storedItems]);

  useEffect(() => {
    const syncCart = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      try { setStoredItems(normalizeItems(JSON.parse(event.newValue ?? '[]'))); } catch { setStoredItems([]); }
    };
    window.addEventListener('storage', syncCart);
    return () => window.removeEventListener('storage', syncCart);
  }, []);

  const items = storedItems.flatMap(({ slug, quantity }) => {
    const product = getProduct(slug);
    return canAddToPreviewCart(product) ? [{ product, quantity, lineTotalCents: product.priceCents * quantity }] : [];
  });
  const itemCount = items.reduce((total, item) => total + item.quantity, 0);
  const subtotalCents = items.reduce((total, item) => total + item.lineTotalCents, 0);

  const updateQuantity = (slug: string, quantity: number) => {
    if (!canAddToPreviewCart(getProduct(slug)) || !Number.isInteger(quantity)) return;
    setStoredItems((current) => quantity < 1 ? current.filter((item) => item.slug !== slug) : current.map((item) => item.slug === slug ? { ...item, quantity: Math.min(MAX_QUANTITY, quantity) } : item));
  };
  const addItem = (slug: string) => {
    if (!canAddToPreviewCart(getProduct(slug))) return;
    setStoredItems((current) => {
      const existing = current.find((item) => item.slug === slug);
      return existing ? current.map((item) => item.slug === slug ? { ...item, quantity: Math.min(MAX_QUANTITY, item.quantity + 1) } : item) : [...current, { slug, quantity: 1 }];
    });
  };
  const removeItem = (slug: string) => setStoredItems((current) => current.filter((item) => item.slug !== slug));

  return <CartContext.Provider value={{ items, itemCount, subtotalCents, isReady, addItem, updateQuantity, removeItem }}>{children}</CartContext.Provider>;
}

export function useCart() {
  const cart = useContext(CartContext);
  if (!cart) throw new Error('useCart must be used within CartProvider');
  return cart;
}
