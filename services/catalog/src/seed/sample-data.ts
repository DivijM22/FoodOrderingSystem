/**
 * Small fictional catalog for manual testing (5 restaurants, 5 items each), seeded with
 * `npm run seed -w @food/catalog-service -- --sample`. Same format as data.ts (rupees,
 * converted to paise by the seeder). Every restaurant is open and every item available;
 * restaurants start with no administrators (a platform admin assigns them later).
 */
import type { SeedRestaurant } from './data.js';

const V = true;
const N = false;

export const SAMPLE_RESTAURANTS: SeedRestaurant[] = [
  {
    slug: 'saffron-handi-biryani',
    name: 'Saffron Handi Biryani',
    description: 'Hyderabadi dum biryanis slow-cooked in sealed handis, with classic kebabs on the side.',
    cuisines: ['Biryani', 'Hyderabadi'],
    tags: ['Dum Biryani', 'Kebabs'],
    address: { line1: '6-3-1090, Raj Bhavan Road', area: 'Somajiguda', city: 'Hyderabad', pincode: '500082' },
    isPureVeg: false, isOpen: true, rating: 4.4, ratingCount: 3820, costForTwo: 650, avgDeliveryMinutes: 35,
    openingHours: { opens: '11:00', closes: '23:30' },
    items: [
      ['Hyderabadi Chicken Dum Biryani', 'Biryani', 319, N, 'Aged basmati and marinated chicken dum-cooked with saffron and fried onions.', 'b s2'],
      ['Mutton Kacchi Biryani', 'Biryani', 429, N, 'Raw-marinated mutton and rice cooked together under a dough seal.', 's2'],
      ['Subz Dum Biryani', 'Biryani', 259, V, 'Seasonal vegetables and paneer layered with mint and whole spices.', 's1'],
      ['Chicken Seekh Kebab', 'Kebabs', 279, N, 'Minced chicken skewers grilled over charcoal, served with mint chutney.', 's2'],
      ['Double Ka Meetha', 'Desserts', 119, V, 'Bread pudding soaked in saffron-cardamom milk and topped with nuts.'],
    ],
  },
  {
    slug: 'malgudi-dosa-house',
    name: 'Malgudi Dosa House',
    description: 'Crisp dosas, soft idlis and strong filter coffee from a family-run Mysuru kitchen.',
    cuisines: ['South Indian', 'Breakfast'],
    tags: ['Pure Veg', 'Filter Coffee'],
    address: { line1: '14, Sayyaji Rao Road', area: 'Devaraja Mohalla', city: 'Mysuru', pincode: '570001' },
    isPureVeg: true, isOpen: true, rating: 4.6, ratingCount: 5210, costForTwo: 250, avgDeliveryMinutes: 25,
    openingHours: { opens: '07:00', closes: '22:00' },
    items: [
      ['Mysore Masala Dosa', 'Dosa', 129, V, 'Crisp dosa with a fiery red chutney spread and potato palya.', 'b s1'],
      ['Ghee Podi Dosa', 'Dosa', 139, V, 'Dosa roasted in ghee and dusted with gunpowder podi.', 's2'],
      ['Idli Vada Combo', 'Breakfast', 99, V, 'Two steamed idlis and a medu vada with sambar and coconut chutney.'],
      ['Rava Kesari', 'Sweets', 69, V, 'Semolina halwa with ghee, cashews and saffron.'],
      ['Filter Coffee', 'Beverages', 49, V, 'Chicory-blend decoction with frothy hot milk.', 'b'],
    ],
  },
  {
    slug: 'amritsari-tadka',
    name: 'Amritsari Tadka',
    description: 'Hearty North Indian curries, tandoor breads and kulchas in the Amritsar dhaba style.',
    cuisines: ['North Indian', 'Punjabi'],
    tags: ['Tandoor', 'Curries'],
    address: { line1: 'SCO 27, Sector 26', area: 'Madhya Marg', city: 'Chandigarh', pincode: '160019' },
    isPureVeg: false, isOpen: true, rating: 4.3, ratingCount: 4470, costForTwo: 700, avgDeliveryMinutes: 40,
    openingHours: { opens: '12:00', closes: '23:00' },
    items: [
      ['Butter Chicken', 'Curries', 349, N, 'Tandoori chicken simmered in a buttery tomato-cashew gravy.', 'b s1'],
      ['Dal Makhani', 'Curries', 249, V, 'Black lentils slow-cooked overnight with butter and cream.', 'b'],
      ['Paneer Tikka Masala', 'Curries', 299, V, 'Grilled paneer cubes in a spiced onion-tomato masala.', 's2'],
      ['Amritsari Kulcha', 'Breads', 89, V, 'Tandoor-baked stuffed potato kulcha brushed with butter.'],
      ['Sweet Lassi', 'Beverages', 79, V, 'Thick churned yoghurt drink topped with malai.'],
    ],
  },
  {
    slug: 'konkan-coast-kitchen',
    name: 'Konkan Coast Kitchen',
    description: 'Malvani and Goan seafood with coconut-rich curries, fry platters and sol kadhi.',
    cuisines: ['Seafood', 'Malvani', 'Goan'],
    tags: ['Coastal', 'Seafood'],
    address: { line1: '3, Shivaji Park Road No. 5', area: 'Dadar West', city: 'Mumbai', pincode: '400028' },
    isPureVeg: false, isOpen: true, rating: 4.5, ratingCount: 2960, costForTwo: 900, avgDeliveryMinutes: 45,
    openingHours: { opens: '12:00', closes: '23:00' },
    items: [
      ['Surmai Fry', 'Fry', 399, N, 'Kingfish steak marinated in Malvani masala and shallow-fried in rava.', 'b s2'],
      ['Prawn Curry Rice', 'Curries', 379, N, 'Prawns in a coconut-kokum curry, served with steamed rice.', 's2'],
      ['Chicken Xacuti', 'Curries', 329, N, 'Goan curry of roasted coconut, poppy seeds and whole spices.', 's2'],
      ['Veg Kolhapuri', 'Curries', 239, V, 'Mixed vegetables in a fiery Kolhapuri masala.', 's3'],
      ['Sol Kadhi', 'Beverages', 69, V, 'Cooling kokum and coconut-milk digestive.'],
    ],
  },
  {
    slug: 'chandni-chowk-chaat-co',
    name: 'Chandni Chowk Chaat Co.',
    description: 'Old Delhi street-food favourites: chaat, chole bhature and sweets, made fresh to order.',
    cuisines: ['Street Food', 'Chaat'],
    tags: ['Pure Veg', 'Snacks'],
    address: { line1: '1124, Chandni Chowk Main Road', area: 'Chandni Chowk', city: 'New Delhi', pincode: '110006' },
    isPureVeg: true, isOpen: true, rating: 4.2, ratingCount: 6130, costForTwo: 300, avgDeliveryMinutes: 30,
    openingHours: { opens: '10:00', closes: '22:30' },
    items: [
      ['Papdi Chaat', 'Chaat', 99, V, 'Crisp papdi with potatoes, yoghurt and tamarind and mint chutneys.', 'b s1'],
      ['Aloo Tikki Chaat', 'Chaat', 109, V, 'Pan-fried potato patties topped with chole, yoghurt and chutneys.', 's1'],
      ['Chole Bhature', 'Mains', 159, V, 'Spicy chickpea curry with two fluffy fried bhature.', 'b s2'],
      ['Dahi Bhalla', 'Chaat', 99, V, 'Soft lentil dumplings in sweetened yoghurt with roasted cumin.'],
      ['Moong Dal Halwa', 'Sweets', 129, V, 'Slow-roasted lentil halwa rich with ghee and nuts.'],
    ],
  },
];
