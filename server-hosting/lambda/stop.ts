import { EC2Client, StopInstancesCommand } from "@aws-sdk/client-ec2";

export const handler = async () => {
  const instanceId = process.env.INSTANCE_ID;
  console.log("Attempting to stop game server", instanceId);

  const client = new EC2Client({ region: process.env.AWS_REGION });
  const command = new StopInstancesCommand({ InstanceIds: [instanceId!] });

  try {
    const response = await client.send(command);
    console.log(JSON.stringify(response));
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/json" },
      body: JSON.stringify({
        message: "Stopped satisfactory server",
        response: JSON.stringify(response),
      }),
    };
  } catch (error) {
    console.error(JSON.stringify(error));
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/json" },
      body: JSON.stringify({
        message: "Failed to stop satisfactory server",
        response: JSON.stringify(error),
      }),
    };
  }
};
