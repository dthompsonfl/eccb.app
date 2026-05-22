import { Metadata } from 'next';
import Link from 'next/link';
import { ContactForm } from '@/components/public/contact-form';
import { Mail, Phone, MapPin, Clock, Navigation } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Contact Us',
  description: 'Get in touch with the Emerald Coast Community Band. We would love to hear from you!',
};

const contactInfo = [
  {
    icon: Mail,
    title: 'Email',
    content: 'info@eccb.app',
    href: 'mailto:info@eccb.app',
  },
  {
    icon: Phone,
    title: 'Phone',
    content: '(850) 555-1234',
    href: 'tel:+18505551234',
  },
  {
    icon: MapPin,
    title: 'Location',
    content: 'Niceville, FL 32578',
    href: null,
  },
  {
    icon: Clock,
    title: 'Rehearsals',
    content: 'Mondays, 7:00 PM - 9:00 PM',
    href: null,
  },
];

export default function ContactPage() {
  return (
    <div className="w-full py-12 md:py-16">
      {/* Hero */}
      <section className="py-16 bg-gradient-to-b from-primary/10 to-transparent">
        <div className="mx-auto w-full max-w-4xl px-6 lg:px-8">
          <div className="max-w-3xl mx-auto">
            <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
              Contact Us
            </h1>
            <p className="mt-6 text-xl text-muted-foreground">
              Have a question or want to learn more about the band? 
              We'd love to hear from you!
            </p>
          </div>
        </div>
      </section>

      {/* Contact Section */}
      <section className="py-16">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="grid lg:grid-cols-2 gap-12">
            {/* Contact Info */}
            <div>
              <h2 className="text-2xl font-bold tracking-tight mb-6">
                Get in Touch
              </h2>
              <p className="text-muted-foreground mb-8">
                Whether you're interested in joining the band, booking us for an event, 
                or just have a question, we're here to help.
              </p>

              <div className="space-y-6">
                {contactInfo.map((item) => (
                  <div key={item.title} className="flex items-start gap-4">
                    <div className="flex-shrink-0 w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center">
                      <item.icon className="h-6 w-6 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-medium">{item.title}</h3>
                      {item.href ? (
                        <a
                          href={item.href}
                          className="text-muted-foreground hover:text-primary transition-colors"
                        >
                          {item.content}
                        </a>
                      ) : (
                        <p className="text-muted-foreground">{item.content}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-8 rounded-xl border bg-muted/40 p-6">
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                    <Navigation className="h-6 w-6 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold">Rehearsal and booking details</h3>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Rehearsal locations and event logistics can vary by season. Submit the form and the band will confirm the current location, parking details, and availability for bookings.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Contact Form */}
            <div className="bg-white dark:bg-slate-800 rounded-2xl p-8 shadow-lg">
              <h2 className="text-2xl font-bold tracking-tight mb-6">
                Send us a Message
              </h2>
              <ContactForm />
            </div>
          </div>
        </div>
      </section>

      {/* FAQ Section */}
      <section className="py-16 bg-slate-50 dark:bg-slate-900">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <h2 className="text-2xl font-bold tracking-tight text-center mb-12">
            Frequently Asked Questions
          </h2>
          <div className="max-w-3xl mx-auto space-y-6">
            <div className="bg-white dark:bg-slate-800 rounded-xl p-6">
              <h3 className="font-semibold">How do I join the band?</h3>
              <p className="mt-2 text-muted-foreground">
                Start with the <Link href="/signup" className="text-primary hover:underline">member signup</Link> flow or use this contact form if you have questions first. Most sections welcome a range of skill levels.
              </p>
            </div>
            <div className="bg-white dark:bg-slate-800 rounded-xl p-6">
              <h3 className="font-semibold">When and where are rehearsals?</h3>
              <p className="mt-2 text-muted-foreground">
                We rehearse every Monday evening from 7:00 PM to 9:00 PM. 
                Contact us for the current rehearsal location.
              </p>
            </div>
            <div className="bg-white dark:bg-slate-800 rounded-xl p-6">
              <h3 className="font-semibold">Are your concerts free?</h3>
              <p className="mt-2 text-muted-foreground">
                Yes! All of our concerts are free and open to the public. 
                We believe great music should be accessible to everyone.
              </p>
            </div>
            <div className="bg-white dark:bg-slate-800 rounded-xl p-6">
              <h3 className="font-semibold">Can I book the band for an event?</h3>
              <p className="mt-2 text-muted-foreground">
                We occasionally perform at community events. Contact us with details 
                about your event and we'll see if we can help.
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
