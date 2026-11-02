-- CreateTable
CREATE TABLE "funding_notice_texts" (
    "id" TEXT NOT NULL,
    "productKey" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "textChecksum" TEXT NOT NULL,
    "documents" JSONB NOT NULL,
    "retrievedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "funding_notice_texts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funding_condition_extractions" (
    "id" TEXT NOT NULL,
    "productKey" TEXT NOT NULL,
    "textChecksum" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "rawOutput" JSONB NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "extractedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "funding_condition_extractions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "funding_notice_texts_productKey_textChecksum_key" ON "funding_notice_texts"("productKey", "textChecksum");

-- CreateIndex
CREATE UNIQUE INDEX "funding_condition_extractions_cache_key" ON "funding_condition_extractions"("productKey", "textChecksum", "model", "promptVersion");

-- AddForeignKey
ALTER TABLE "funding_condition_extractions" ADD CONSTRAINT "funding_condition_extractions_productKey_textChecksum_fkey" FOREIGN KEY ("productKey", "textChecksum") REFERENCES "funding_notice_texts"("productKey", "textChecksum") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- 인용 검증과 추출 캐시가 같은 본문을 가리키도록 checksum을 본문에서 정한다(ADR 0009 §3).
ALTER TABLE "funding_notice_texts" ADD CONSTRAINT "funding_notice_texts_textChecksum_check" CHECK ("textChecksum" = encode(sha256(convert_to("text", 'UTF8')), 'hex'));
