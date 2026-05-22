'use client';

import { useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { ChevronRight, Play, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';


const instruments = [
  { id: 1, name: 'Bass Guitar', image: '/instrument-bass.png' },
  { id: 2, name: 'Acoustic Guitar', image: '/instrument-acoustic.png' },
  { id: 3, name: 'Electric Guitar', image: '/instrument-electric.png' },
];

const particles = [
  { id: 1, size: 4, left: '15%', top: '20%', delay: 0 },
  { id: 2, size: 6, left: '80%', top: '30%', delay: 2 },
  { id: 3, size: 3, left: '25%', top: '70%', delay: 4 },
  { id: 4, size: 5, left: '75%', top: '60%', delay: 1 },
  { id: 5, size: 4, left: '50%', top: '40%', delay: 3 },
  { id: 6, size: 7, left: '90%', top: '80%', delay: 5 },
];

export default function Hero() {
  const [currentInstrument, setCurrentInstrument] = useState(0);
  const [isCarouselHovered, setIsCarouselHovered] = useState(false);
  const heroRef = useRef<HTMLDivElement>(null);
  const headlineRef = useRef<HTMLDivElement>(null);
  const subtextRef = useRef<HTMLParagraphElement>(null);
  const ctaRef = useRef<HTMLDivElement>(null);
  const carouselRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      // Timeline for orchestrated entrance
      const tl = gsap.timeline({ defaults: { ease: 'expo.out' } });

      // Headline with character animation
      tl.fromTo(
        '.headline-word',
        { y: 100, opacity: 0, rotateX: -90 },
        { 
          y: 0, 
          opacity: 1, 
          rotateX: 0,
          duration: 0.8, 
          stagger: 0.08,
        },
        0.3
      );

      // Subtext with blur reveal
      tl.fromTo(
        subtextRef.current,
        { filter: 'blur(20px)', opacity: 0, y: 30 },
        { filter: 'blur(0px)', opacity: 1, y: 0, duration: 0.8 },
        0.8
      );

      // CTA buttons with elastic bounce
      tl.fromTo(
        '.cta-primary',
        { scale: 0, opacity: 0 },
        { scale: 1, opacity: 1, duration: 0.6, ease: 'elastic.out(1, 0.5)' },
        1.1
      );

      tl.fromTo(
        '.cta-secondary',
        { x: 50, opacity: 0 },
        { x: 0, opacity: 1, duration: 0.5 },
        1.3
      );

      // 3D carousel flip entrance
      tl.fromTo(
        carouselRef.current,
        { rotateY: 90, opacity: 0, scale: 0.8 },
        { rotateY: 0, opacity: 1, scale: 1, duration: 1, ease: 'expo.out' },
        0.5
      );

      // Decorative elements
      tl.fromTo(
        '.hero-decoration',
        { scale: 0, opacity: 0 },
        { scale: 1, opacity: 1, duration: 0.6, stagger: 0.1, ease: 'elastic.out(1, 0.5)' },
        1.2
      );
    });

    return () => ctx.revert();
  }, []);

  // Auto-rotate instruments with pause on hover
  useEffect(() => {
    if (isCarouselHovered) return;
    
    const interval = setInterval(() => {
      setCurrentInstrument((prev) => (prev + 1) % instruments.length);
    }, 3500);
    return () => clearInterval(interval);
  }, [isCarouselHovered]);

  const scrollToSection = (href: string) => {
    const element = document.querySelector(href);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
    }
  };

  const headlineWords = ['Unleash', 'Your', 'Musical', 'Talent'];

  return (
    <section
      id="home"
      ref={heroRef}
      className="relative min-h-screen w-full overflow-hidden"
    >
      {/* Solid Color Background */}
      <div className="absolute inset-0 z-0 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
        {/* Animated gradient overlay */}
        <div className="absolute inset-0 gradient-pulse opacity-20">
          <div className="absolute inset-0 bg-gradient-to-br from-teal-600/30 via-transparent to-purple-900/20" />
        </div>

        {/* Particle effects */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          {particles.map((particle) => (
            <div
              key={particle.id}
              className="hero-particle"
              style={{
                width: particle.size,
                height: particle.size,
                left: particle.left,
                top: particle.top,
                animationDelay: `${particle.delay}s`,
              }}
            />
          ))}
        </div>
      </div>

      {/* Decorative circles */}
      <div className="absolute top-1/4 right-[15%] w-64 h-64 rounded-full border border-teal-400/20 hero-decoration opacity-0" />
      <div className="absolute bottom-1/4 right-[25%] w-32 h-32 rounded-full border border-teal-300/30 hero-decoration opacity-0" />

      {/* Content */}
      <div className="relative z-20 w-full min-h-screen flex items-center">
        <div className="w-full px-4 sm:px-6 lg:px-12 xl:px-20 py-32">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
            {/* Left Content */}
            <div className="max-w-2xl">
              {/* Badge */}
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 backdrop-blur-sm border border-white/20 mb-8">
                <Volume2 className="w-4 h-4 text-teal-300" />
                <span className="text-sm text-white/90 font-medium">Fort Walton Beach, Florida</span>
              </div>

              {/* Headline with 3D perspective */}
              <div ref={headlineRef} className="mb-6" style={{ perspective: '1000px' }}>
                <h1 className="font-display text-5xl sm:text-6xl lg:text-7xl font-bold text-white leading-tight">
                  {headlineWords.map((word, index) => (
                    <span
                      key={index}
                      className="headline-word inline-block mr-4"
                      style={{
                        transformStyle: 'preserve-3d',
                      }}
                    >
                      {index === 3 ? (
                        <span className="text-gradient">{word}</span>
                      ) : (
                        word
                      )}
                    </span>
                  ))}
                </h1>
              </div>

              {/* Subtext */}
              <p
                ref={subtextRef}
                className="text-lg sm:text-xl text-white/80 mb-8 max-w-xl leading-relaxed"
              >
                Join our vibrant community of musicians on the beautiful Emerald Coast. 
                Open to all skill levels. Weekly rehearsals every Tuesday at 7 PM at Meigs Middle School.
              </p>

              {/* Stats */}
              <div className="flex gap-8 mb-8">
                <div>
                  <p className="text-3xl font-display font-bold text-white">50+</p>
                  <p className="text-sm text-white/60">Active Members</p>
                </div>
                <div className="w-px bg-white/20" />
                <div>
                  <p className="text-3xl font-display font-bold text-white">10+</p>
                  <p className="text-sm text-white/60">Years Strong</p>
                </div>
                <div className="w-px bg-white/20" />
                <div>
                  <p className="text-3xl font-display font-bold text-white">∞</p>
                  <p className="text-sm text-white/60">Possibilities</p>
                </div>
              </div>

              {/* CTA Buttons */}
              <div ref={ctaRef} className="flex flex-col sm:flex-row gap-4">
                <Button
                  onClick={() => scrollToSection('#join')}
                  className="cta-primary bg-teal-600 hover:bg-teal-500 text-white font-semibold px-8 py-6 text-lg glow-pulse-enhanced transition-all duration-300 hover:scale-105 group"
                >
                  <Play className="mr-2 w-5 h-5 transition-transform group-hover:scale-110" />
                  Join The Band
                  <ChevronRight className="ml-2 w-5 h-5 transition-transform group-hover:translate-x-1" />
                </Button>
                <Button
                  onClick={() => scrollToSection('#about')}
                  variant="outline"
                  className="cta-secondary border-white/30 text-white hover:bg-white/10 hover:border-white/50 px-8 py-6 text-lg backdrop-blur-sm transition-all duration-300 group"
                >
                  Learn More
                  <ChevronRight className="ml-2 w-5 h-5 transition-transform group-hover:translate-x-1" />
                </Button>
              </div>
            </div>

            {/* Right Content - Enhanced 3D Instrument Carousel */}
            <div className="hidden lg:flex justify-center items-center">
              <div
                ref={carouselRef}
                className="relative w-96 h-96"
                style={{ perspective: '1200px' }}
                onMouseEnter={() => setIsCarouselHovered(true)}
                onMouseLeave={() => setIsCarouselHovered(false)}
              >
                {/* Carousel stage */}
                <div 
                  className="relative w-full h-full"
                  style={{
                    transformStyle: 'preserve-3d',
                    transform: `rotateY(${-currentInstrument * 120}deg)`,
                    transition: 'transform 0.8s cubic-bezier(0.16, 1, 0.3, 1)',
                  }}
                >
                  {instruments.map((instrument, index) => {
                    const angle = index * 120;
                    const isActive = index === currentInstrument;

                    return (
                      <div
                        key={instrument.id}
                        className="absolute inset-0 flex items-center justify-center"
                        style={{
                          transform: `rotateY(${angle}deg) translateZ(180px)`,
                          backfaceVisibility: 'hidden',
                        }}
                      >
                        <div 
                          className={`w-64 h-80 rounded-3xl overflow-hidden transition-all duration-500 ${
                            isActive 
                              ? 'shadow-3d-hover scale-100' 
                              : 'shadow-3d scale-90 opacity-70'
                          }`}
                          style={{
                            background: 'linear-gradient(145deg, #ffffff, #f8fafc)',
                            boxShadow: isActive 
                              ? '0 25px 50px -12px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(15, 118, 110, 0.1)' 
                              : '0 10px 30px -10px rgba(0, 0, 0, 0.2)',
                          }}
                        >
                          <div className="w-full h-full p-6 flex flex-col items-center justify-center">
                            <img
                              src={instrument.image}
                              alt={instrument.name}
                              className="w-full h-full object-contain drop-shadow-2xl"
                            />
                          </div>
                          
                          {/* Shimmer effect on active */}
                          {isActive && (
                            <div className="absolute inset-0 shimmer opacity-30 rounded-3xl" />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Carousel indicators */}
                <div className="absolute -bottom-12 left-1/2 -translate-x-1/2 flex gap-3">
                  {instruments.map((_, index) => (
                    <button
                      key={index}
                      onClick={() => setCurrentInstrument(index)}
                      className={`relative h-2 rounded-full transition-all duration-500 ${
                        index === currentInstrument
                          ? 'w-10 bg-gradient-to-r from-teal-400 to-teal-300 shadow-lg shadow-teal-400/50'
                          : 'w-2 bg-white/30 hover:bg-white/50'
                      }`}
                    >
                      {index === currentInstrument && (
                        <div className="absolute inset-0 bg-gradient-to-r from-teal-400 to-teal-300 rounded-full animate-pulse" />
                      )}
                    </button>
                  ))}
                </div>

                {/* Decorative ring */}
                <div className="absolute inset-0 rounded-full border border-teal-400/20 rotate-slow" 
                  style={{ transform: 'translateZ(-50px)' }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Wave decoration at bottom */}
      <div className="absolute bottom-0 left-0 right-0 z-30">
        <svg
          viewBox="0 0 1440 120"
          className="w-full h-auto"
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id="waveGradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="50%" stopColor="#f9fafb" />
              <stop offset="100%" stopColor="#ffffff" />
            </linearGradient>
          </defs>
          <path
            d="M0,60 C240,100 480,20 720,60 C960,100 1200,20 1440,60 L1440,120 L0,120 Z"
            fill="url(#waveGradient)"
          />
          <path
            d="M0,80 C240,40 480,100 720,60 C960,20 1200,80 1440,40 L1440,120 L0,120 Z"
            fill="rgba(15, 118, 110, 0.05)"
          />
        </svg>
      </div>
    </section>
  );
}
