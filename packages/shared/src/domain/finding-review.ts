export type FindingReviewStatus =
  | 'pending'
  | 'confirmed'
  | 'false_positive'
  | 'ignored';

export const FINDING_REVIEW_STATUSES: FindingReviewStatus[] = [
  'pending', 'confirmed', 'false_positive', 'ignored',
];
