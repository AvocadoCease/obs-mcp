import { OBSWebSocketClient } from "./client.js";

export type ImageContent = {
  [x: string]: unknown;
  type: "image";
  data: string;
  mimeType: string;
};

export interface ScreenshotOptions {
  sourceName?: string;
  sourceUuid?: string;
  imageFormat?: string;
  imageWidth?: number;
  imageHeight?: number;
  imageCompressionQuality?: number;
}

/**
 * Screenshot a source or scene and return it as MCP image content so the model can actually see it.
 * OBS returns a data URI ("data:image/png;base64,..."), which is split into mime type and payload.
 */
export async function captureScreenshot(client: OBSWebSocketClient, options: ScreenshotOptions): Promise<ImageContent> {
  const imageFormat = options.imageFormat || "png";
  const response = await client.sendRequest("GetSourceScreenshot", { ...options, imageFormat });
  const imageData: string = response.imageData;

  const match = /^data:([^;]+);base64,(.*)$/s.exec(imageData);
  if (match) {
    return { type: "image", mimeType: match[1], data: match[2] };
  }
  return { type: "image", mimeType: `image/${imageFormat === "jpg" ? "jpeg" : imageFormat}`, data: imageData };
}
