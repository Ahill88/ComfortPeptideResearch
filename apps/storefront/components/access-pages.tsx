'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { ArrowRight, CheckCircle2, KeyRound, MailCheck, ShieldCheck } from 'lucide-react';
import { useAuth } from './auth-provider';

const inputClass = 'min-h-11 w-full rounded-2xl border border-silver bg-white px-4 py-3 text-sm text-midnight outline-none transition placeholder:text-slate-500 focus:border-slate-500 focus:ring-2 focus:ring-ice';
const buttonClass = 'inline-flex min-h-11 items-center justify-center gap-3 rounded-2xl border border-midnight bg-midnight px-5 py-3.5 text-xs font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50';

function AccessShell({ eyebrow, title, children }: { eyebrow: string; title: string; children: React.ReactNode }) {
  return <main className="min-h-[calc(100vh-72px)] bg-porcelain px-5 py-12 font-sans text-midnight sm:px-8 lg:grid lg:place-items-center lg:py-24 [&_a]:min-h-11 [&_a]:items-center [&_a]:inline-flex"><div className="mx-auto grid w-full max-w-[1280px] overflow-hidden rounded-2xl border border-silver bg-white lg:grid-cols-[.82fr_1.18fr]"><aside className="bg-midnight p-8 text-white sm:p-12 lg:p-16"><p className="text-[10px] font-medium tracking-[.17em] text-ice">CUSTOMER ACCESS</p><h1 className="mt-8 text-4xl leading-[1.08] tracking-[-.045em] sm:text-5xl">Research purchasing,<br /><span className="text-ice">streamlined.</span></h1><p className="mt-7 max-w-sm text-sm leading-7 text-slate-300">Manage your account, review orders, and track shipment details in one focused workspace.</p><div className="mt-12 border-t border-white/20 pt-6 text-xs leading-6 text-slate-300">LOCAL PREVIEW ONLY<br />This browser session is not secure production authentication.</div></aside><section className="min-w-0 p-7 sm:p-12 lg:p-16"><p className="text-[10px] font-medium tracking-[.17em] text-slate-600">{eyebrow}</p><h2 className="mt-4 text-4xl leading-tight tracking-tight sm:text-5xl">{title}</h2>{children}</section></div></main>;
}

export function AccessEntry() {
  return <AccessShell eyebrow="WELCOME" title="Choose your route."><p className="mt-5 max-w-md text-sm leading-6 text-slate-600">Sign in to your account or create a new profile. Catalog browsing remains open to everyone.</p><div className="mt-9 grid gap-3 sm:grid-cols-2"><Link className={buttonClass} href="/login">Sign in <ArrowRight size={15} /></Link><Link className="inline-flex min-h-11 items-center justify-center rounded-2xl border border-silver px-5 py-3.5 text-xs font-semibold transition hover:bg-porcelain" href="/register">Create account</Link></div><Link className="mt-8 inline-flex items-center gap-2 text-xs font-semibold underline underline-offset-4" href="/catalog">Browse the catalog <ArrowRight size={14} /></Link></AccessShell>;
}

export function LoginPage() {
  const router = useRouter(); const { signIn } = useAuth(); const [email, setEmail] = useState('');
  const submit = (event: FormEvent) => { event.preventDefault(); signIn(email); router.push('/account'); };
  return <AccessShell eyebrow="RETURNING CUSTOMER" title="Welcome back."><form className="mt-8 space-y-4" onSubmit={submit}><label className="block text-xs font-bold uppercase tracking-[.1em]">Email<input required className={`${inputClass} mt-2`} value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="you@laboratory.org" /></label><label className="block text-xs font-bold uppercase tracking-[.1em]">Password<input required minLength={8} className={`${inputClass} mt-2`} type="password" placeholder="Enter any 8+ characters" /></label><button className={`${buttonClass} mt-2 w-full`} type="submit">Sign in <ArrowRight size={15} /></button></form><div className="mt-6 flex flex-wrap gap-x-5 gap-y-3 text-xs"><Link className="underline underline-offset-4" href="/forgot-password">Forgot password?</Link><Link className="underline underline-offset-4" href="/register">Create an account</Link></div><p className="mt-7 border-t border-line pt-4 text-[11px] leading-5 text-slate-500">Local preview: credentials are not verified or transmitted, and this is not secure production authentication.</p></AccessShell>;
}

export function RegisterPage() {
  const router = useRouter(); const { register } = useAuth(); const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [terms, setTerms] = useState(false);
  const submit = (event: FormEvent) => { event.preventDefault(); if (!terms) return; register(name, email); router.push('/verify-email'); };
  return <AccessShell eyebrow="NEW CUSTOMER" title="Create your profile."><form className="mt-8 space-y-4" onSubmit={submit}><label className="block text-xs font-bold uppercase tracking-[.1em]">Full name<input required className={`${inputClass} mt-2`} value={name} onChange={(e) => setName(e.target.value)} placeholder="Dr. Avery Chen" /></label><label className="block text-xs font-bold uppercase tracking-[.1em]">Email<input required className={`${inputClass} mt-2`} value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="you@laboratory.org" /></label><label className="block text-xs font-bold uppercase tracking-[.1em]">Password<input required minLength={8} className={`${inputClass} mt-2`} type="password" placeholder="At least 8 characters" /></label><label className="flex min-h-11 cursor-pointer items-center gap-3 py-2 text-xs leading-5 text-slate-600"><input required className="h-5 w-5 shrink-0 accent-midnight" checked={terms} onChange={(e) => setTerms(e.target.checked)} type="checkbox" />I am a qualified purchaser and agree to the research-use terms.</label><button disabled={!terms} className={`${buttonClass} w-full`} type="submit">Create account <ArrowRight size={15} /></button></form><p className="mt-6 text-xs">Already registered? <Link className="underline underline-offset-4" href="/login">Sign in</Link>.</p></AccessShell>;
}

export function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  return <AccessShell eyebrow="PASSWORD HELP" title="Reset your password.">{sent ? <div className="mt-8 rounded-2xl border border-silver bg-porcelain p-6 text-sm leading-6"><MailCheck className="mb-3 text-slate-600" /><b className="block text-midnight">Preview reset link prepared.</b>In a production integration, reset instructions would be sent to your email. <Link className="underline" href="/reset-password">Continue to the preview reset screen</Link>.</div> : <form className="mt-8 space-y-4" onSubmit={(e) => { e.preventDefault(); setSent(true); }}><label className="block text-xs font-bold uppercase tracking-[.1em]">Email<input required className={`${inputClass} mt-2`} type="email" placeholder="you@laboratory.org" /></label><button className={buttonClass}>Send preview reset link <ArrowRight size={15} /></button></form>}<Link className="mt-6 inline-block text-xs underline underline-offset-4" href="/login">Back to sign in</Link></AccessShell>;
}

export function ResetPasswordPage() {
  const router = useRouter(); const [complete, setComplete] = useState(false);
  return <AccessShell eyebrow="PASSWORD HELP" title="Choose a new password.">{complete ? <div className="mt-8 rounded-2xl border border-silver bg-porcelain p-6 text-sm leading-6"><CheckCircle2 className="mb-3 text-slate-600" />Preview password updated locally. <Link className="underline" href="/login">Return to sign in</Link>.</div> : <form className="mt-8 space-y-4" onSubmit={(e) => { e.preventDefault(); setComplete(true); router.prefetch('/login'); }}><label className="block text-xs font-bold uppercase tracking-[.1em]">New password<input required minLength={8} className={`${inputClass} mt-2`} type="password" /></label><label className="block text-xs font-bold uppercase tracking-[.1em]">Confirm password<input required minLength={8} className={`${inputClass} mt-2`} type="password" /></label><button className={buttonClass}>Update preview password <KeyRound size={15} /></button></form>}</AccessShell>;
}

export function VerifyEmailPage() {
  const router = useRouter(); const { session, verifyEmail } = useAuth();
  return <AccessShell eyebrow="VERIFICATION PENDING" title="Confirm your email."><div className="mt-8 break-words rounded-2xl border border-silver bg-porcelain p-6 text-sm leading-6"><MailCheck className="mb-3 text-slate-600" /><b className="block text-midnight">A verification link is ready.</b>In this local preview, no email is sent. Confirming below marks {session?.email ?? 'your email'} as verified in this browser only.</div><button className={`${buttonClass} mt-6`} onClick={() => { verifyEmail(); router.push('/account'); }}>Confirm local preview email <ShieldCheck size={15} /></button></AccessShell>;
}
