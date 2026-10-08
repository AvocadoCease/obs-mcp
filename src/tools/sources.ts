import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OBSWebSocketClient } from "../client.js";
import { z } from "zod";
import { captureScreenshot } from "../screenshot.js";

export async function initialize(server: McpServer, client: OBSWebSocketClient): Promise<void> {
  // GetSourceActive tool
  server.tool(
    "obs-get-source-active",
    "Gets the active and show state of a source",
    {
      sourceName: z.string().optional().describe("Name of the source to get the active state of"),
      sourceUuid: z.string().optional().describe("UUID of the source to get the active state of")
    },
    async ({ sourceName, sourceUuid }) => {
      try {
        const response = await client.sendRequest("GetSourceActive", {
          sourceName,
          sourceUuid
        });
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting source active state: ${error instanceof Error ? error.message : String(error)}`
            }
          ],
          isError: true
        };
      }
    }
  );

  // GetSourceScreenshot tool
  server.tool(
    "obs-get-source-screenshot",
    "Screenshot a source or scene and return it as an image you can look at. Pass a scene name to see exactly what that scene outputs.",
    {
      sourceName: z.string().optional().describe("Name of the source or scene to take a screenshot of"),
      sourceUuid: z.string().optional().describe("UUID of the source to take a screenshot of"),
      imageFormat: z.string().optional().describe("Image compression format to use (default: png)"),
      imageWidth: z.number().optional().describe("Width to scale the screenshot to (default: 1280, aspect ratio is kept)"),
      imageHeight: z.number().optional().describe("Height to scale the screenshot to"),
      imageCompressionQuality: z.number().optional().describe("Compression quality to use (0-100, -1 for default)")
    },
    async ({ sourceName, sourceUuid, imageFormat, imageWidth, imageHeight, imageCompressionQuality }) => {
      try {
        const image = await captureScreenshot(client, {
          sourceName,
          sourceUuid,
          imageFormat,
          imageWidth: imageWidth ?? (imageHeight ? undefined : 1280),
          imageHeight,
          imageCompressionQuality
        });

        return {
          content: [image]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting source screenshot: ${error instanceof Error ? error.message : String(error)}`
            }
          ],
          isError: true
        };
      }
    }
  );

  // SaveSourceScreenshot tool
  server.tool(
    "obs-save-source-screenshot",
    "Saves a screenshot of a source to the filesystem",
    {
      sourceName: z.string().optional().describe("Name of the source to take a screenshot of"),
      sourceUuid: z.string().optional().describe("UUID of the source to take a screenshot of"),
      imageFormat: z.string().describe("Image compression format to use"),
      imageFilePath: z.string().describe("Path to save the screenshot file to"),
      imageWidth: z.number().optional().describe("Width to scale the screenshot to"),
      imageHeight: z.number().optional().describe("Height to scale the screenshot to"),
      imageCompressionQuality: z.number().optional().describe("Compression quality to use (0-100, -1 for default)")
    },
    async ({ sourceName, sourceUuid, imageFormat, imageFilePath, imageWidth, imageHeight, imageCompressionQuality }) => {
      try {
        await client.sendRequest("SaveSourceScreenshot", {
          sourceName,
          sourceUuid,
          imageFormat,
          imageFilePath,
          imageWidth,
          imageHeight,
          imageCompressionQuality
        });
        
        return {
          content: [
            {
              type: "text",
              text: `Successfully saved screenshot to: ${imageFilePath}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error saving source screenshot: ${error instanceof Error ? error.message : String(error)}`
            }
          ],
          isError: true
        };
      }
    }
  );
}