import { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Music, Users, Award, Heart, ArrowRight } from 'lucide-react';

export const metadata: Metadata = {
  title: 'About Us',
  description: 'Learn about the Emerald Coast Community Band, our history, mission, and the musicians who make it all possible.',
};

const values = [
  {
    icon: Music,
    title: 'Musical Excellence',
    description: 'We strive for the highest quality in every performance, challenging ourselves to grow as musicians.',
  },
  {
    icon: Users,
    title: 'Community',
    description: 'We bring together musicians of all backgrounds, creating a welcoming space for everyone.',
  },
  {
    icon: Award,
    title: 'Education',
    description: 'We support music education and provide opportunities for lifelong learning.',
  },
  {
    icon: Heart,
    title: 'Service',
    description: 'We serve our community through free concerts and support for local causes.',
  },
];

export default function AboutPage() {
  return (
    <div className="w-full py-12 md:py-16">
      {/* Hero */}
      <section className="py-16 bg-gradient-to-b from-primary/10 to-transparent">
        <div className="mx-auto w-full max-w-4xl px-6 lg:px-8">
          <div className="max-w-3xl mx-auto">
            <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
              About the Band
            </h1>
            <p className="mt-6 text-xl text-muted-foreground">
              The Emerald Coast Community Band has been bringing quality concert band music 
              to Northwest Florida for nearly four decades.
            </p>
          </div>
        </div>
      </section>

      {/* Mission */}
      <section className="py-16">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="text-3xl font-bold tracking-tight">Our Mission</h2>
              <p className="mt-6 text-lg text-muted-foreground">
                The Emerald Coast Community Band exists to provide a musical outlet for adult 
                musicians, to promote music education, and to enrich the cultural life of our 
                community through quality concert band performances.
              </p>
              <p className="mt-4 text-lg text-muted-foreground">
                We believe that music has the power to bring people together, inspire creativity, 
                and create lasting memories. Our volunteer musicians share a common passion for 
                music and a commitment to excellence.
              </p>
            </div>
            <div className="aspect-video bg-slate-200 dark:bg-slate-800 rounded-2xl flex items-center justify-center">
              <Music className="h-16 w-16 text-muted-foreground" />
            </div>
          </div>
        </div>
      </section>

      {/* Values */}
      <section className="py-16 bg-slate-50 dark:bg-slate-900">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <h2 className="text-3xl font-bold tracking-tight text-center mb-12">
            Our Values
          </h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-8">
            {values.map((value) => (
              <div
                key={value.title}
                className="bg-white dark:bg-slate-800 rounded-xl p-6 shadow-sm"
              >
                <value.icon className="h-10 w-10 text-primary mb-4" />
                <h3 className="text-lg font-semibold">{value.title}</h3>
                <p className="mt-2 text-muted-foreground">{value.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* History */}
      <section className="py-16">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="max-w-3xl mx-auto">
            <h2 className="text-3xl font-bold tracking-tight text-center mb-8">
              Our History
            </h2>
            <div className="prose prose-lg dark:prose-invert mx-auto">
              <p>
                Founded in 1985, the Emerald Coast Community Band began as a small group of 
                dedicated musicians who wanted to continue making music after their school 
                and college years.
              </p>
              <p>
                Over the decades, we've grown to include over 75 members representing a wide 
                range of ages, professions, and musical backgrounds. Our members include 
                teachers, engineers, healthcare workers, retirees, and students—all united 
                by a love of music.
              </p>
              <p>
                We perform several concerts each season at venues throughout the Emerald Coast 
                region, including holiday concerts, spring shows, and special community events. 
                Our repertoire spans classical masterworks, contemporary band literature, 
                patriotic favorites, and popular standards.
              </p>
            </div>
            <div className="mt-12 text-center">
              <Button asChild>
                <Link href="/about">
                  Read Our Full History
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-16 bg-primary text-primary-foreground">
        <div className="mx-auto max-w-7xl px-6 lg:px-8 text-center">
          <h2 className="text-3xl font-bold tracking-tight">
            Want to Join Us?
          </h2>
          <p className="mt-4 text-lg max-w-2xl mx-auto opacity-90">
            We're always looking for new members who share our passion for music. 
            All skill levels are welcome!
          </p>
          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Button size="lg" variant="secondary" asChild>
              <Link href="/signup">
                Join the Band
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild className="border-white/30 hover:bg-white/10">
              <Link href="/contact">
                Contact Us
              </Link>
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
