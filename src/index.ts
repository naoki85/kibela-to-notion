import { Config } from "./Config";
import { getPrefixNumber, isTitlePropertyValue } from "./notionHelpers";
import { NotionRepository } from "./repository/NotionRepository";
import { getAllMetaData } from "./metaParser";
import { RedisRepository } from "./repository/RedisRepository";
import { getUpdateProperties } from "./updateProp";
import { chunk } from "./utils";

export const main = async () => {
  console.time("notion");
  const notionRepo = new NotionRepository(Config.Notion.KEY);
  const redisRepo = new RedisRepository({
    showFriendlyErrorStack: Config.Redis.SHOW_FRIENDLY_ERROR_STACK,
    noDelay: Config.Redis.NO_DELAY,
  });
  const DATABASE = Config.Notion.DATABASE;
  const allMetaData = getAllMetaData();
  const allPrefix = allMetaData.map(item => item.prefixNumber);
  const chunkedAllPrefix = chunk(allPrefix, 100);
  const allPages = await Promise.all(
    chunkedAllPrefix.map(async chunkedPrefix => {
      return await notionRepo.getAllPageFromDatabase(DATABASE, chunkedPrefix);
    })
  );
  let successCount = 0;

  for await (const pages of allPages) {
    for await (const page of pages) {
      const nameProp = page.properties.Name;
      if (!isTitlePropertyValue(nameProp)) continue;
      const url = page.url;
      const number = getPrefixNumber(url);
      if (!number) continue;
      const metaData = allMetaData.find(item => item.prefixNumber === number);
      if (!metaData) continue;
      const updateProps = await getUpdateProperties({
        content: metaData.meta,
        redisRepo,
      });
      console.dir({ updateProps }, { depth: null });
      const updatedPage = await notionRepo
        .updatePage(page, updateProps, redisRepo)
        .catch(err => {
          console.error({ err, successCount });
        });
      if (!updatedPage) continue;
      if (updatedPage) successCount++;
      const ignorePropNames = ["Name", "comments", "prefixNumber"];

      for (const propKey in updatedPage.properties) {
        console.log({ propKey });
        if (ignorePropNames.includes(propKey)) continue;
        const propValue = updatedPage.properties[propKey];
        if (propValue.type === "select") {
          const { id, name } = propValue.select;
          const key = `${propKey}:${name!}`;
          if (await redisRepo.getKey(key)) continue;
          await redisRepo.set(key, id!);
          continue;
        }
        if (propValue.type !== "multi_select") continue;
        for await (const menu of propValue.multi_select) {
          const { id, name } = menu;
          const key = `${propKey}:${name!}`;
          if (await redisRepo.getKey(key)) continue;
          await redisRepo.set(key, id!);
          continue;
        }
      }
    }
  }
  console.log({ successCount });
  console.timeEnd();
  process.exit();
};

main();
