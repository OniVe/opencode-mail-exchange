declare module "word-extractor" {
  export default class WordExtractor {
    extract(source: Buffer | string): Promise<{
      getBody(): string
      getHeaders(): string
      getFooters(): string
    }>
  }
}
