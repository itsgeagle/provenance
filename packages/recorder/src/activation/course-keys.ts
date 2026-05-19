/**
 * The course public key is the verification anchor for every `.cs61a` manifest the
 * recorder loads (PRD §4.1). Re-exported from a tiny sibling file so the production
 * build (`npm run build:prod`) can swap that file in place without touching anything
 * else. See course-public-key.ts and tools/embed-course-key.ts.
 */
export { COURSE_PUBLIC_KEY_HEX } from './course-public-key.js';
