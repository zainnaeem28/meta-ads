/** SCREEN-005 copy (UI-UX §8, §9 and the frame text). */
export const SCREEN_005_COPY = {
  title: 'Campaigns',
  description: 'Your ad campaigns and drafts. Only you can see them.',
  newBrief: 'New brief',
  tabsLabel: 'Campaigns and drafts',
  historyTab: 'History',
  draftsTab: 'Drafts',
  searchLabel: 'Search by product name or description',
  chips: { all: 'All', processing: 'Processing', completed: 'Completed', failed: 'Failed' },
  historyLabel: 'Campaign history',
  draftsLabel: 'Drafts',
  loading: 'Loading campaigns',
  perPage: (n: number) => `${n} per page`,
  previous: 'Previous',
  next: 'Next',
  pagination: 'Pagination',
  empty: {
    title: 'No campaigns yet',
    body: 'Start with a brief. Enter the product and audience, and ShrooMap drafts a brand-checked script you can turn into a video ad.',
  },
  draftsEmpty: {
    title: 'No drafts',
    body: 'Drafts you start appear here until you generate the brief. Nothing is waiting for you.',
  },
  noResults: {
    title: (what: string) => `No campaigns match ${what}`,
    body: 'Try a different product name or description, or clear the status filter.',
    draftsBody: 'Try a different product name or description.',
    action: 'Clear search and filters',
  },
  error: {
    title: 'Campaigns could not be loaded',
    body: 'Something went wrong on our side. Your campaigns are safe. Try again in a moment.',
  },
  keyMissing: {
    title: 'Add your provider keys to start generating',
    body: 'Brief generation needs your OpenAI key and clip generation needs your WaveSpeed key. Costs are billed to your own provider accounts.',
    action: 'Add provider keys',
  },
  deleteDialog: {
    campaignTitle: (name: string) => `Delete "${name}"?`,
    draftTitle: (name: string) => `Delete draft "${name}"?`,
    campaignBody:
      'This removes the campaign for everyone, including its brief, its clips, any final video and the product image. Clips still generating are cancelled.',
    draftBody: 'This removes the draft and its product image.',
    warning:
      'Credit already spent at WaveSpeed or OpenAI cannot be recovered. Copies held by those providers are removed only where they allow it.',
    irreversible: 'This cannot be undone.',
    campaignConfirm: 'Delete campaign',
    draftConfirm: 'Delete draft',
  },
  toast: {
    campaign: 'Campaign deleted. Its media is being removed in the background.',
    draft: 'Draft deleted. Its product image is removed.',
  },
  untitledDraft: 'Untitled draft',
  draftStatus: 'Draft',
  steps: ['Format', 'Product', 'Audience and direction', 'Concept and script'],
  deleteLabel: (name: string, draft: boolean) => (draft ? `Delete draft ${name}` : `Delete ${name}`),
} as const;
