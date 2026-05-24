import {
  Anchor,
  Baby,
  Bell,
  Building2,
  Car,
  Check,
  CircleParking,
  Clock,
  Coffee,
  Cpu,
  Droplets,
  Dumbbell,
  Film,
  Flame,
  Heart,
  Home,
  Key,
  Leaf,
  Mail,
  MapPin,
  PawPrint,
  Palmtree,
  Phone,
  ShieldCheck,
  Sparkles,
  Star,
  Sun,
  Trees,
  Umbrella,
  UtensilsCrossed,
  Warehouse,
  Waves,
  Wifi,
  Wine,
  Zap,
  type LucideIcon,
} from 'lucide-react'

// Mapping from amenity-icon-name (the editor's `icon` string field on
// each amenity row) to a Lucide component. The editor's field is
// free-text so this map is a render-time best-effort lookup with a
// safe fallback (`Check`) — admins typing "outdoor cinema" still get
// a usable bullet.
//
// Keys are lower-cased + dash-normalised on lookup, so the editor
// can store "Smart Home", "smart_home", "smart-home", "smart home"
// and all four resolve to the same icon. Add new aliases by adding
// more entries pointing to the same icon.
//
// The set is intentionally curated, not exhaustive. Each entry has
// to earn its place — a freeform icon library would tempt operators
// into icon soup. Common Ghana / Africa luxury real-estate amenities
// dominate the list; expand by addition only.

const ICONS: Record<string, LucideIcon> = {
  pool: Waves,
  'swimming-pool': Waves,
  water: Waves,
  lake: Waves,

  gym: Dumbbell,
  fitness: Dumbbell,
  'fitness-center': Dumbbell,

  concierge: Bell,
  bell: Bell,
  reception: Bell,

  garden: Trees,
  trees: Trees,
  greenery: Leaf,
  leaf: Leaf,
  park: Trees,
  'park-view': Trees,

  'smart-home': Cpu,
  smart: Cpu,
  cpu: Cpu,
  automation: Cpu,

  parking: CircleParking,
  garage: CircleParking,
  car: Car,
  driveway: Car,

  security: ShieldCheck,
  shield: ShieldCheck,
  cctv: ShieldCheck,
  guard: ShieldCheck,
  gated: ShieldCheck,

  elevator: Building2,
  lift: Building2,
  tower: Building2,
  building: Building2,
  highrise: Building2,

  wifi: Wifi,
  internet: Wifi,
  fibre: Wifi,
  fiber: Wifi,

  beach: Palmtree,
  palm: Palmtree,
  tropical: Palmtree,

  spa: Sparkles,
  sparkles: Sparkles,
  wellness: Sparkles,
  premium: Sparkles,

  cafe: Coffee,
  coffee: Coffee,
  lounge: Coffee,

  restaurant: UtensilsCrossed,
  dining: UtensilsCrossed,
  utensils: UtensilsCrossed,
  kitchen: UtensilsCrossed,

  bar: Wine,
  wine: Wine,

  cinema: Film,
  film: Film,
  theater: Film,
  theatre: Film,
  'home-theater': Film,

  bbq: Flame,
  fire: Flame,
  grill: Flame,
  fireplace: Flame,

  solar: Sun,
  sun: Sun,

  generator: Zap,
  power: Zap,
  'backup-power': Zap,
  energy: Zap,

  storage: Warehouse,
  warehouse: Warehouse,

  marina: Anchor,
  anchor: Anchor,
  dock: Anchor,

  fountain: Droplets,
  droplets: Droplets,
  'water-feature': Droplets,

  playground: Baby,
  kids: Baby,
  children: Baby,
  nursery: Baby,

  pet: PawPrint,
  'pet-friendly': PawPrint,
  dog: PawPrint,
  paw: PawPrint,

  rooftop: Umbrella,
  terrace: Umbrella,
  cabana: Umbrella,
  umbrella: Umbrella,

  home: Home,
  villa: Home,
  cottage: Home,
  residence: Home,

  key: Key,
  keyless: Key,
  access: Key,

  // Chunk F additions — extends the amenity-focused registry with a
  // small set of universal icons that the new Elementor-parity widgets
  // (IconBox + IconList) seed-payloads and operators-typing-from-memory
  // both reach for. Star + heart + check are the "generic positive
  // marker" trio that don't map naturally onto any amenity keyword.
  check: Check,
  checkmark: Check,
  tick: Check,
  star: Star,
  favorite: Star,
  award: Star,
  heart: Heart,
  love: Heart,

  // Contact / location / time — used by the Contact source page's
  // channels grid and any Icon Box widget pointing at email/phone/
  // address/hours. Operators typing "mail" / "email" both land on the
  // envelope; "phone" / "call" / "tel" on the receiver; "address" /
  // "location" / "map" on the map pin; "hours" / "time" on the clock.
  mail: Mail,
  email: Mail,
  envelope: Mail,
  phone: Phone,
  call: Phone,
  tel: Phone,
  'map-pin': MapPin,
  pin: MapPin,
  address: MapPin,
  location: MapPin,
  map: MapPin,
  clock: Clock,
  hours: Clock,
  time: Clock,
}

const FALLBACK: LucideIcon = Check

export function iconForAmenity(name: string | null | undefined): LucideIcon {
  if (!name) return FALLBACK
  const key = name.toLowerCase().trim().replace(/[\s_]+/g, '-')
  return ICONS[key] ?? FALLBACK
}
