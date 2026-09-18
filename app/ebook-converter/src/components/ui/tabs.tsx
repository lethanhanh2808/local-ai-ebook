// src/components/ui/tabs.tsx
//
// Tabs primitive (UI Polish 2026-07-06; re-skinned 2026-09-18 for the
// East-Asian paper visual world) — wraps @radix-ui/react-tabs.
//
// Default visual is an underline rail: a hairline bottom border with a
// vermilion underline on the active trigger. Matches the navigation
// underline pattern used elsewhere (AppNav, library tabs).
//
// Override via className for vertical contexts:
//
//   <TabsList className="flex-row lg:flex-col lg:items-stretch
//                          lg:border-b-0 lg:border-l lg:sticky lg:top-20">
//     <TabsTrigger value="…" className="lg:justify-start lg:px-3 lg:py-2.5
//                                          lg:border-b-0 lg:border-l-2 lg:-ml-px">
//       Label
//     </TabsTrigger>
//   </TabsList>
//
// Roving focus + arrow-key navigation come from Radix; we only own the
// visual layer.
//
// Usage:
//   <Tabs defaultValue="general">
//     <TabsList>
//       <TabsTrigger value="general">General</TabsTrigger>
//       <TabsTrigger value="tts">TTS</TabsTrigger>
//     </TabsList>
//     <TabsContent value="general">...</TabsContent>
//     <TabsContent value="tts">...</TabsContent>
//   </Tabs>

'use client';

import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/utils';
import { forwardRef, ComponentPropsWithoutRef, ElementRef } from 'react';

export const Tabs = TabsPrimitive.Root;

export const TabsList = forwardRef<
  ElementRef<typeof TabsPrimitive.List>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      // Underline rail: hairline bottom border, no fill, no rounding.
      // Callers override for vertical contexts (left-rail nav).
      'inline-flex items-center border-b border-border',
      className,
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

export const TabsTrigger = forwardRef<
  ElementRef<typeof TabsPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      // Vermilion underline on active. `-mb-px` pulls the active border
      // down into the parent rail's hairline so it reads as a single line.
      'inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium whitespace-nowrap',
      'border-b-2 border-transparent -mb-px text-muted-foreground transition-colors',
      'hover:text-foreground',
      'data-[state=active]:border-primary data-[state=active]:text-foreground',
      'disabled:pointer-events-none disabled:opacity-50',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ring-offset-background',
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

export const TabsContent = forwardRef<
  ElementRef<typeof TabsPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      'mt-4 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;
