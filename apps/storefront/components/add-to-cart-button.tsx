'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useCart } from './cart-provider';
import { canAddToPreviewCart, getProduct } from '../lib/products';

export function AddToCartButton({ slug, className, children, quantity = 1 }: { slug: string; className: string; children: ReactNode; quantity?: number }) {
  const { addItem, items, isReady } = useCart();
  const [added, setAdded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const existingQuantity = items.find((item) => item.product.slug === slug)?.quantity ?? 0;
  const exceedsLimit = !Number.isInteger(quantity) || quantity < 1 || existingQuantity + quantity > 99;
  const available = canAddToPreviewCart(getProduct(slug));
  const add = () => {
    if (!available || !isReady || exceedsLimit) return;
    for (let index = 0; index < quantity; index++) addItem(slug);
    setAdded(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setAdded(false), 1600);
  };
  return <button className={`${className} disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-slate-500`} type="button" onClick={add} disabled={!available || !isReady || exceedsLimit} aria-live="polite">{!available ? 'COMING SOON' : added ? 'Added to bag' : exceedsLimit ? 'Bag limit: 99 per item' : children}</button>;
}
