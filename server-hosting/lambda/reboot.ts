import { EC2Client, RebootInstancesCommand } from "@aws-sdk/client-ec2";

export const handler = async () => {
  const instanceId = process.env.INSTANCE_ID;
  console.log("Attempting to reboot game server", instanceId);

  const client = new EC2Client({ region: process.env.AWS_REGION });
  const command = new RebootInstancesCommand({ InstanceIds: [instanceId!] });

  try {
    const response = await client.send(command);
    console.log(JSON.stringify(response));
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/json" },
      body: JSON.stringify({
        message: "Rebooted satisfactory server",
        response: JSON.stringify(response),
      }),
    };
  } catch (error) {
    console.error(JSON.stringify(error));
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/json" },
      body: JSON.stringify({
        message: "Failed to reboot satisfactory server",
        response: JSON.stringify(error),
      }),
    };
  }
};
