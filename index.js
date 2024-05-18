// Run the script by plugging in the Kobo to the computer and executing run.bat.

// Load environment variables
require("dotenv").config();

// Import necessary modules
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");
const { Client } = require("@notionhq/client");

// Initialize Notion client with the token from environment variables
const notion = new Client({ auth: process.env.NOTION_TOKEN });

// Function to find the Kobo eReader drive
async function findKoboDrive() {
  try {
    // This command lists all drives with their volume names
    const stdout = execSync("wmic logicaldisk get name, volumename").toString();
    const lines = stdout.trim().split(os.EOL);
    for (const line of lines) {
      if (line.includes("KOBOeReader")) {
        const match = line.match(/(\w:)/); // This regex finds drive letters
        if (match) {
          return `${match[1]}\\.kobo\\KoboReader.sqlite`;
        }
      }
    }
  } catch (error) {
    console.error("Failed to find KOBOeReader drive:", error);
  }
  return null;
}

// Define the path for the new database file
const dbPath = path.join("highlights.sqlite");

// Function to ensure directory exists and copy the SQLite file
async function setupDatabase() {
  const koboPath = await findKoboDrive();
  if (!koboPath) {
    console.error("Kobo eReader not found.");
    return false;
  }

  try {
    // Ensure the directory exists
    await fs.promises.mkdir(path.dirname(dbPath), { recursive: true });

    // Copy the SQLite file to the new location
    await fs.promises.copyFile(koboPath, dbPath);
    console.log(`Database file copied and renamed to ${dbPath}\n`);
    return true; // Return true to indicate success
  } catch (error) {
    console.error("Failed to setup database file:", error);
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
      const title = book.Title;

      // Query Notion to check if the book already exists
      const response = await notion.databases.query({
        database_id: process.env.NOTION_DATABASE_ID,
        filter: {
          property: "Title",
          text: { contains: title },
        },
      });

      let pageId;
      let isNewPage = false;
      let skipHighlights = false;

      if (response.results.length === 1) {
        pageId = response.results[0].id;
        if (response.results[0].properties.Highlights.checkbox === true) {
          console.log(
            `${title}: highlights checkbox has been checked. Skipping new highlights.`
          );
          skipHighlights = true;
        }
      } else if (response.results.length === 0) {
        const newPage = await notion.pages.create({
          parent: { database_id: process.env.NOTION_DATABASE_ID },
          properties: {
            Title: { title: [{ text: { content: title } }] },
            Highlights: { checkbox: false },
          },
        });
        pageId = newPage.id;
        isNewPage = true;
        console.log(`${title}: new page created.`);
      } else {
        console.log(
          `${title} matched multiple items. Skipping to avoid duplicates.`
        );
        continue;
      }

      if (skipHighlights) {
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
          heading_1: {
            text: [{ type: "text", text: { content: "Review" } }],
            is_toggleable: true,
          },
        });
      }

      // Create the "Highlights" block and prepare to add highlight quotes as children
      let highlightBlocks = highlightsList.map((highlight) => ({
        object: "block",
        type: "quote",
        quote: {
          rich_text: [
            { type: "text", text: { content: highlight.Text.trim() } },
          ],
        },
      }));

      // Add the "Highlights" block with nested highlight quotes
      blocks.push({
        object: "block",
        type: "heading_1",
        heading_1: {
          text: [{ type: "text", text: { content: "Highlights" } }],
          children: highlightBlocks,
          is_toggleable: true,
        },
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

      console.log(`${title}: uploaded highlights.`);
    } catch (error) {
      console.log(`${book.Title}: error: `, error);
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
