import { embed } from "ai";
import { MastraAgentRelevanceScorer, rerankWithScorer } from "@mastra/rag";

import { vectorStore, INDEX_NAME } from "./vector-store";
import { getChatModel, getEmbeddingModel } from "../llm/provider";

/**
 * Embeds `query`, retrieves the top-K vector matches, then reranks for relevance.
 * Returns an array of result objects ordered by relevance score.
 */
export async function retrieveContext(query: string, topK = 5) {
  // 1. Embed the query
  const { embedding } = await embed({
    model: getEmbeddingModel(),
    value: query,
  });

  // 2. Vector similarity search — no category/type filters
  const initialResults = await vectorStore.query({
    indexName: INDEX_NAME,
    queryVector: embedding,
    topK: 10,
  });

  if (!initialResults.length) return [];

  // 3. Rerank for semantic relevance
  const relevanceScorer = new MastraAgentRelevanceScorer(
    "kb-relevance-scorer",
    getChatModel() as any
  );

  const reranked = await rerankWithScorer({
    results: initialResults,
    query,
    scorer: relevanceScorer,
    options: {
      weights: { semantic: 0.5, vector: 0.3, position: 0.2 },
      topK,
    },
  });

  return reranked;
}
