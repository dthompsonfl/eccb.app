import React from 'react';
import Link from 'next/link';
import { Facebook, Instagram, Twitter, Mail, MapPin, Phone } from 'lucide-react';
import { Logo } from '@/components/icons/logo';

export function Footer() {
  return (
    <footer className="bg-neutral-dark pt-20 pb-10 text-white">
      <div className="mx-auto w-full max-w-7xl px-6">
        <div className="grid gap-12 md:grid-cols-4">
          {/* Brand Column */}
          <div className="md:col-span-1">
            <Link href="/" className="mb-6 flex items-center gap-3" aria-label="Emerald Coast Community Band">
              <Logo className="h-10 w-auto text-primary" />
              <span className="sr-only">Emerald Coast Community Band</span>
            </Link>
            <p className="mb-8 text-sm leading-relaxed text-gray-400">
              The Emerald Coast Community Band is a non-profit organization dedicated
              to musical excellence and community enrichment through concert band performances.
            </p>
            <div className="flex gap-4">
              <a href="https://facebook.com" target="_blank" rel="noopener noreferrer" aria-label="Facebook" className="rounded-full bg-white/5 p-2 transition-colors hover:bg-primary">
                <Facebook size={18} />
              </a>
              <a href="https://instagram.com" target="_blank" rel="noopener noreferrer" aria-label="Instagram" className="rounded-full bg-white/5 p-2 transition-colors hover:bg-primary">
                <Instagram size={18} />
              </a>
              <a href="https://x.com" target="_blank" rel="noopener noreferrer" aria-label="X/Twitter" className="rounded-full bg-white/5 p-2 transition-colors hover:bg-primary">
                <Twitter size={18} />
              </a>
            </div>
          </div>

          {/* Quick Links */}
          <div>
            <h4 className="mb-6 font-display text-lg font-bold uppercase tracking-widest text-primary">
              Quick Links
            </h4>
            <ul className="space-y-4 text-sm text-gray-400">
              <li>
                <Link href="/about" className="hover:text-primary transition-colors">About Us</Link>
              </li>
              <li>
                <Link href="/events" className="hover:text-primary transition-colors">Events & Concerts</Link>
              </li>
              <li>
                <Link href="/member/music" className="hover:text-primary transition-colors">Music Library</Link>
              </li>
              <li>
                <Link href="/signup" className="hover:text-primary transition-colors">Join the Band</Link>
              </li>
              <li>
                <Link href="/contact" className="hover:text-primary transition-colors">Contact Us</Link>
              </li>
            </ul>
          </div>

          {/* Contact Info */}
          <div>
            <h4 className="mb-6 font-display text-lg font-bold uppercase tracking-widest text-primary">
              Visit Us
            </h4>
            <ul className="space-y-4 text-sm text-gray-400">
              <li className="flex items-start gap-3">
                <MapPin className="mt-0.5 text-primary" size={18} />
                <span>Emerald Coast Area<br />Destin, Florida</span>
              </li>
              <li className="flex items-center gap-3">
                <Mail className="text-primary" size={18} />
                <a href="mailto:info@eccb.app" className="hover:text-primary transition-colors">
                  info@eccb.app
                </a>
              </li>
              <li className="flex items-center gap-3">
                <Phone className="text-primary" size={18} />
                <span>(555) 123-4567</span>
              </li>
            </ul>
          </div>

          {/* Newsletter / Join */}
          <div>
            <h4 className="mb-6 font-display text-lg font-bold uppercase tracking-widest text-primary">
              Members
            </h4>
            <p className="mb-6 text-sm text-gray-400">
              Access the digital music library and manage your orchestra profile.
            </p>
            <Link 
              href="/login" 
              className="inline-block rounded-lg bg-primary/20 px-6 py-3 text-sm font-bold text-primary transition-all hover:bg-primary hover:text-white"
            >
              Member Portal
            </Link>
          </div>
        </div>

        <div className="mt-20 border-t border-white/5 pt-8 text-center text-xs text-gray-500">
          <p>
            &copy; {new Date().getFullYear()} Emerald Coast Community Band. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
