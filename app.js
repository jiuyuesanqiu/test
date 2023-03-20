const express = require("express");
const app = express();
const querystring = require("querystring");
const crypto = require("crypto");
const { encrypt, getSignature, decrypt } = require("@wecom/crypto");
const getRawBody = require("raw-body");
const xml2js = require("xml2js");
const axios = require("axios");

const {
  WECHAT_CORP_ID,
  WECHAT_CORP_SECRET,
  OPENAI_API_KEY,
  REDIS_HOST,
  REDIS_PORT,
  REDIS_PASSWORD,
  WECHAT_TOKEN,
  WECHAT_ENCODING_AES_KEY,
} = process.env;

const USER_MEMBERSHIP_LEVEL_KEY = "user_membership_level";

// openAi设置
const { Configuration, OpenAIApi } = require("openai");
const configuration = new Configuration({
  apiKey: OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

const Redis = require("ioredis");
const redis = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
});

const CACHE_KEY = "access_token";
async function getAccessToken() {
  const cachedAccessToken = await redis.get(CACHE_KEY);
  if (cachedAccessToken) {
    return cachedAccessToken;
  }
  const response = await axios.get(
    `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${WECHAT_CORP_ID}&corpsecret=${WECHAT_CORP_SECRET}`
  );
  const { access_token, expires_in } = response.data;
  await redis.set(CACHE_KEY, access_token, "EX", expires_in);

  return access_token;
}

async function sendMessage(content, users) {
  const access_token = await getAccessToken();

  const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${access_token}`;
  const data = {
    touser: users,
    msgtype: "text",
    agentid: "1000002",
    text: {
      content,
    },
  };
  await axios.post(url, data);
}

app.get(`/`, (req, res) => {
  res.send("首页");
});

function parseXml(xml) {
  return new Promise((resolve, reject) => {
    xml2js.parseString(xml, (err, result) => {
      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    });
  });
}

//封装xml消息
const builder = new xml2js.Builder({ cdata: true });

function buildXML(data) {
  const xml = builder.buildObject({ xml: data });
  return xml;
}
const USER_EXPIRATION_KEY = "user_expiration";


function parseQueryParams(req) {
  const query = querystring.parse(req.url.split("?")[1]);
  const { timestamp, nonce, msg_signature } = query;
  return { timestamp, nonce ,msg_signature};
}
async function parseWechatMessage(msg_encrypt) {
  const { message: msgxml } = decrypt(WECHAT_ENCODING_AES_KEY, msg_encrypt);
  return parseXml(msgxml);
}

async function getMessageLimit(fromUserName) {
  const membershipLevel = await redis.hget(
    USER_MEMBERSHIP_LEVEL_KEY,
    fromUserName
  );
  let messageLimit = 0;
  let limitReachedMsg = "";

  switch (membershipLevel) {
    case "standard":
      messageLimit = 1000;
      limitReachedMsg =
        "已达到本月上限，联系管理员开通高级会员可以提升发消息数量";
      break;
    case "premium":
      messageLimit = 3000;
      limitReachedMsg =
        "已达到本月上限，联系管理员开通专业会员可以提升发消息数量";
      break;
    case "professional":
      messageLimit = Infinity;
      break;
    default:
      messageLimit = 10;
      limitReachedMsg =
        "已达到今日上限，联系管理员开通会员可以提升发消息数量";
  }

  return { messageLimit, limitReachedMsg };
}

async function getUserMessageCount(fromUserName, messageLimit) {
  const keyPrefix = messageLimit === 10 ? "user_daily_message_" : "user_monthly_message_";
  const dateStr = messageLimit === 10 ? "day" : "month";
  const today = new Date().toISOString().slice(0, messageLimit === 10 ? 10 : 7);
  const userMessageKey = `${keyPrefix}${fromUserName}_${today}`;
  const count = parseInt((await redis.get(userMessageKey)) || 0);
  return count;
}

async function canSendMessage(fromUserName, messageLimit) {
  if (messageLimit === Infinity) {
    return true;
  }

  const count = await getUserMessageCount(fromUserName, messageLimit);

  if (count >= messageLimit) {
    const encry_res_xml = assemblePassiveReply(
      toUserName,
      fromUserName,
      limitReachedMsg,
      agentID
    );
    return { canSend: false, encry_res_xml };
  } else {
    return { canSend: true };
  }
}

async function sendTextMessage(text, fromUserName) {
  const message = generateTextMessage(text, fromUserName);
  await sendMessage(message, fromUserName);
}

// 新接口
app.post("/receiveWechat", async (req, res) => {
  try {
    const { timestamp, nonce ,msg_signature} = parseQueryParams(req);
    const xml = (
      await getRawBody(req, {
        length: req.headers["content-length"],
        encoding: "utf-8",
      })
    ).toString();
    
    //验证签名是否有效
    const result = await parseXml(xml);
    const msg_encrypt = result.xml.Encrypt[0];
    const hashedStr = getSignature(WECHAT_TOKEN, timestamp, nonce, msg_encrypt);
    if (hashedStr !== msg_signature) {
      console.log("签名验证失败");
      res.send("");
      return;
    }
    console.log("签名验证通过");

    const msgResult = await parseWechatMessage(msg_encrypt);
    const {
      ToUserName: [toUserName],
      FromUserName: [fromUserName],
      CreateTime: [createTime],
      MsgType: [msgType],
      Content: [content],
      MsgId: [msgId],
      AgentID: [agentID],
    } = msgResult.xml;
    
    const { messageLimit, limitReachedMsg } = await getMessageLimit(fromUserName);
    const { canSend, encry_res_xml } = await canSendMessage(fromUserName, messageLimit);

    if (canSend) {
      const text = await generateText(content, fromUserName);
      await sendTextMessage(text, fromUserName);
      res.send("");
    } else {
      res.set("Content-Type", "application/xml");
      res.send(encry_res_xml);
    }
  } catch (err) {
    console.error(err);
    res.status(500).send("Error reading request body");
  }
});


//设置会员等级
app.post("/setMembershipLevel", (req, res) => {
  const { userId, membershipLevel, expirationType, duration } = req.body;
  const expiration = calculateExpiration(expirationType, duration);
  redis.hset(USER_MEMBERSHIP_LEVEL_KEY, userId, membershipLevel, (err) => {
    if (err) {
      console.error(err);
      res.status(500).send("Error setting membership level");
    } else {
      redis.hset(USER_EXPIRATION_KEY, userId, expiration, (err) => {
        if (err) {
          console.error(err);
          res.status(500).send("Error setting expiration");
        } else {
          res.send("Membership level and expiration set successfully");
        }
      });
    }
  });
});

// 计算过期时间
function calculateExpiration(expirationType, duration) {
  const now = new Date();
  switch (expirationType) {
    case "month":
      now.setMonth(now.getMonth() + duration);
      break;
    case "year":
      now.setFullYear(now.getFullYear() + duration);
      break;
    default:
      throw new Error("Invalid expiration type");
  }
  return now.getTime();
}

const USER_MESSAGES_KEY = "user_messages";
const MESSAGE_CONTEXT_LENGTH = 20;


// 利用openai生成回复
async function generateText(content, userid) {
  const message = { role: "user", content };
  redis.lpush(USER_MESSAGES_KEY + ":" + userid, JSON.stringify(message));
  // 在 generateText 函数中添加如下代码
  const result = await redis.lrange(
    USER_MESSAGES_KEY + ":" + userid,
    0,
    MESSAGE_CONTEXT_LENGTH - 1
  );
  // 删除旧消息
  if (result.length > MESSAGE_CONTEXT_LENGTH) {
    const messagesToDelete = result.slice(MESSAGE_CONTEXT_LENGTH);
    redis.ltrim(
      USER_MESSAGES_KEY + ":" + userid,
      -1 * MESSAGE_CONTEXT_LENGTH,
      -1
    );
    console.log(
      `Deleted ${messagesToDelete.length} old messages from ${USER_MESSAGES_KEY}:${userid}`
    );
  }

  const messages = result.map((message) => JSON.parse(message));
  messages.push({
    role: "system",
    content: "你叫NED，你是一个人工智能助手，尽量简要回复用户的问题",
  });
  messages.reverse();
  console.log("发送给openai的消息", messages);
  // 调用 OpenAI API 生成回复并发送给用户
  try {
    const response = await openai.createChatCompletion({
      model: "gpt-3.5-turbo",
      messages,
      max_tokens: 2000,
      temperature: 0.5,
      user: crypto.createHash("md5").update(userid).digest("hex"),
    });

    const text = response.data.choices[0].message.content.trim();
    console.log("openai返回的数据", text);
    redis.lpush(
      USER_MESSAGES_KEY + ":" + userid,
      JSON.stringify({ role: "assistant", content: text })
    );
    return text;
  } catch (error) {
    console.error(error);
    throw new Error("调用openai接口错误");
  }
}

// 组装被动回复
function assemblePassiveReply(ToUserName, FromUserName, Content, agentID) {
  // 构建被动回复消息
  const resCreateTime = Math.round(new Date().getTime() / 1000);
  const data = {
    ToUserName,
    FromUserName,
    CreateTime: resCreateTime,
    MsgType: "text",
    Content,
  };
  // 明文消息xml
  const resxml = buildXML(data);
  // 加密明文消息
  const resRan = crypto.randomBytes(16);
  const res_encrypt_Msg = encrypt(
    WECHAT_ENCODING_AES_KEY,
    resxml,
    agentID,
    resRan
  );
  const resNonce = Math.random().toString(36).slice(2);
  const resSig = getSignature(
    WECHAT_TOKEN,
    resCreateTime,
    resNonce,
    res_encrypt_Msg
  );
  const encry_res_xml = buildXML({
    Encrypt: res_encrypt_Msg,
    MsgSignature: resSig,
    TimeStamp: resCreateTime,
    Nonce: resNonce,
  });
  return encry_res_xml;
}

// Error handler
app.use(function (err, req, res, next) {
  console.error(err);
  res.status(500).send("Internal Serverless Error");
});

// Web 类型云函数，只能监听 9000 端口
app.listen(9000, () => {
  console.log(`Server start on http://localhost:9000`);
});
