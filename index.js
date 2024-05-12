// Load environment variables
require("dotenv").config();

// Import necessary modules
const fs = require("fs");
const path = require("path");
const { Client } = require("@notionhq/client");

// Initialize Notion client with the token from environment variables
const notion = new Client({ auth: process.env.NOTION_TOKEN });

// Define the path for the original and new database file
const originalPath = "E:\\.kobo\\KoboReader.sqlite";
const dbPath = path.join("highlights.sqlite");

// Function to ensure directory exists and copy the SQLite file
async function setupDatabase() {
  try {
    // Ensure the directory exists
    await fs.promises.mkdir(path.dirname(dbPath), { recursive: true });

    // Copy the SQLite file to the new location
    await fs.promises.copyFile(originalPath, dbPath);
    console.log(`Database file copied and renamed to ${dbPath}\n`);
    return true; // Return true to indicate success
  } catch (error) {
    console.error("Failed to setup database file:\n", error);
    return false; // Return false to indicate failure
  }
}

// Function to export highlights from SQLite to Notion
async function exportHighlights() {
  const db = require("better-sqlite3")(dbPath);

  const getBookListQuery = `
    SELECT DISTINCT content.ContentId, content.Title, content.Attribution AS Author
    FROM Bookmark
    INNER JOIN content ON Bookmark.VolumeID = content.ContentID
    ORDER BY content.Title`;
  const bookList = db.prepare(getBookListQuery).all();

  for (const book of bookList) {
    try {
      const title = book.Title.split(":")[0].trim(); // Simplify and trim title

      // Normalize case for more consistent matching
      const normalizedTitle = title.toLowerCase();

      // Query Notion to check if the book already exists
      const response = await notion.databases.query({
        database_id: process.env.NOTION_DATABASE_ID,
        filter: {
          property: "Title",
          text: { equals: normalizedTitle },
        },
      });

      let pageId;
      let isNewPage = false;

      if (response.results.length === 1) {
        // Use existing page
        pageId = response.results[0].id;
      } else if (response.results.length === 0) {
        // Create a new page if it doesn't exist
        const newPage = await notion.pages.create({
          parent: { database_id: process.env.NOTION_DATABASE_ID },
          properties: {
            Title: {
              title: [{ text: { content: title } }],
            },
            Highlights: { checkbox: false },
          },
        });
        pageId = newPage.id;
        isNewPage = true;
        console.log(`Created a new page for ${title}.`);
      } else {
        // More than one match found, log and skip
        console.log(
          `${title} matched multiple items. Skipping to avoid duplicates.`
        );
        continue;
      }

      const getHighlightsQuery = `
        SELECT Bookmark.Text
        FROM Bookmark
        INNER JOIN content ON Bookmark.VolumeID = content.ContentID
        WHERE content.ContentID = ?
        ORDER BY content.DateCreated DESC`;
      const highlightsList = db.prepare(getHighlightsQuery).all(book.ContentID);

      let blocks = [];

      // Add "Review" block only if it's a new page
      if (isNewPage) {
        blocks.push({
          object: "block",
          type: "heading_1",
          heading_1: { text: [{ type: "text", text: { content: "Review" } }] },
        });
      }

      // Always add the "Highlights" block
      blocks.push({
        object: "block",
        type: "heading_1",
        heading_1: {
          text: [{ type: "text", text: { content: "Highlights" } }],
        },
      });

      // Add the highlight quotes
      highlightsList.forEach((highlight) => {
        if (highlight.Text) {
          blocks.push({
            object: "block",
            type: "quote",
            quote: {
              text: [{ type: "text", text: { content: highlight.Text } }],
            },
          });
        }
      });

      // Append blocks to the Notion page
      await notion.blocks.children.append({
        block_id: pageId,
        children: blocks,
      });

      // Update the page to mark highlights as added
      await notion.pages.update({
        page_id: pageId,
        properties: { Highlights: { checkbox: true } },
      });

      console.log(`Uploaded highlights for ${title}.`);
    } catch (error) {
      console.log(`Error with ${book.Title}: `, error);
    }
  }
}

// Execute the database setup then export the highlights
setupDatabase()
  .then((success) => {
    if (success) {
      exportHighlights();
    }
  })
  .catch(console.error);
