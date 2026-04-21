// server/api/feed.ts
export default defineEventHandler((event) => {
  // Később itt fogunk csatlakozni a Prisma-val a PostgreSQL-hez!
  
  return [
    {
      id: 'art_1',
      title: 'Global Energy Shifts: Rise of Decentralized Power Grids',
      sourceDomain: 'reuters.com',
      date: '2023-10-24',
      rating: 9,
      isPaywall: true,
      aiReasoningTags: ['Energy Sector', 'Infrastructure'],
      summary: 'Prioritized based on your interest in decentralized infrastructure trends and historical engagement levels.'
    },
    {
      id: 'art_2',
      title: 'The Evolution of AI Agents in Decentralized Markets',
      sourceDomain: 'wired.com',
      date: '2023-10-22',
      rating: 9,
      isPaywall: false,
      aiReasoningTags: ['React Nuance'],
      summary: 'Direct relevance to your current project on autonomous sift protocols and agent logic.'
    },
    {
      id: 'art_3',
      title: 'Major Tech Hub Approved for Bandon with NuSift Protocol',
      sourceDomain: 'bandonnews.ie',
      date: '2023-10-24',
      rating: 8,
      isPaywall: true,
      aiReasoningTags: ['Bandon Market node', 'Infrastructure'],
      summary: 'High correlation with Bandon Market protocol updates and infrastructure development in followed tech nodes.'
    }
  ]
})