export type CinematicMedia = {
  poster: string;
  video: string | null;
  description: string;
  caption: string;
};

// Populate video only after an approved, local asset exists. Null never emits a video request.
export const media = {
  hero: {
    poster: '/media/hero/hero-studio.png', video: null,
    description: 'A studio-quality 3D concept render of a glass research vial on a porcelain pedestal.',
    caption: 'Original 3D concept render / not verified product photography',
  },
  molecular: {
    poster: '/media/molecular/abstract-field.svg', video: null,
    description: 'Abstract intersecting orbital lines and points in an ice-blue field.',
    caption: 'Abstract illustration / not a molecular structure',
  },
  laboratory: {
    poster: '/media/laboratory/laboratory-study.svg', video: null,
    description: 'An architectural illustration of a quiet laboratory-inspired interior.',
    caption: 'Concept illustration / not an actual facility or operations',
  },
} satisfies Record<string, CinematicMedia>;
