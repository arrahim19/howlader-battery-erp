import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { appURL, ids, openApp } from "./fixtures/mobile";

// Exercise the actual native session provider across new JavaScript runtimes.
// Only platform adapters are substituted: persistent storage survives reload,
// while real password verification, local replica and session hooks execute.
async function sessionHarness() {
  const adapters: Record<string, string> = {
    "react-native": `export const Platform={OS:'android'};export const AppState={currentState:'active',addEventListener:()=>({remove(){}})};`,
    "expo-network": `export const getNetworkStateAsync=async()=>({isConnected:localStorage.getItem('offline')!=='true'});export const addNetworkStateListener=()=>({remove(){}});`,
    "expo-secure-store": `export const getItemAsync=async k=>localStorage.getItem(k);export const setItemAsync=async(k,v)=>{localStorage.setItem(k,v)};export const deleteItemAsync=async k=>{localStorage.removeItem(k)};`,
    "expo-crypto": `export const getRandomBytes=n=>crypto.getRandomValues(new Uint8Array(n));export const randomUUID=()=>crypto.randomUUID();`,
  };
  const result = await build({
    stdin: {
      contents: `
        import React,{useState} from 'react';
        import {createRoot} from 'react-dom/client';
        import {SessionProvider,useSession} from './apps/mobile/src/lib/session';
        import {handleDeviceBack} from './apps/mobile/src/lib/device-back';
        function LoginHost(){
          const auth=useSession(),[error,setError]=useState(''),[stock,setStock]=useState('');
          if(auth.loading)return <p>Starting</p>;
          return <><p role="alert">{error}</p>{auth.user?<>
            <h1>Unlocked workspace</h1><p data-testid="pending">{auth.syncStatus.pending}</p>
            <button onClick={()=>handleDeviceBack('/dashboard',{canGoBack:()=>true,back:()=>{throw Error('Must exit instead of popping a protected route')},home:()=>{},lock:auth.forget,exit:()=>{window.deviceExited=true}})}>Exit with Android Back</button>
            <button onClick={async()=>{
              await auth.submit('/sales/complete',{customerId:'${ids.customer}',saleDate:'2026-11-23',items:[{productId:'${ids.product}',quantity:1,unitPrice:'150.00'}],paidAmount:'0.00'},crypto.randomUUID());
              const result=await auth.local.read('/products');setStock(result.data.items[0].stock.available);
            }}>Save offline sale</button>
            <button onClick={async()=>{const r=await auth.local.read('/products');setStock(r.data.items[0].stock.available)}}>Read stock</button>
            <p data-testid="stock">{stock}</p>
          </>:<form onSubmit={async e=>{
            e.preventDefault();const form=new FormData(e.currentTarget);setError('');
            try{await auth.signIn('https://erp.test',String(form.get('login')),String(form.get('password')))}catch(e){setError(e.message)}
          }}><h1>Device login</h1><label>Email<input name="login" defaultValue="rahim.mugnee@gmail.com"/></label><label>Password<input name="password" type="password"/></label><button>Unlock</button></form>}</>;
        }
        createRoot(document.getElementById('root')).render(<SessionProvider><LoginHost/></SessionProvider>);
      `,
      loader: "tsx",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "native-test-adapters",
        setup(builder) {
          builder.onResolve(
            {
              filter:
                /^(react-native|expo-network|expo-secure-store|expo-crypto)$/,
            },
            (args) => ({ path: args.path, namespace: "native-test" }),
          );
          builder.onLoad(
            { filter: /.*/, namespace: "native-test" },
            (args) => ({ contents: adapters[args.path], loader: "js" }),
          );
        },
      },
    ],
  });
  return (
    '<!doctype html><div id="root"></div><script>' +
    result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script") +
    "</script>"
  );
}

test("closing the app locks it; enrolled credentials unlock offline and preserve pending local work", async ({
  page,
  context,
}) => {
  const requests = await openApp(page, false);
  const html = await sessionHarness();
  await page.route("**/session-harness", (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  // Existing installations can still contain the former auto-login key.
  await page.evaluate(() =>
    localStorage.setItem(
      "hawlader.session.v1",
      JSON.stringify({
        accessToken: "ab".repeat(32),
        origin: "https://erp.test",
        expiresAt: "2099-01-01T00:00:00Z",
      }),
    ),
  );
  await page.goto(appURL + "/session-harness");
  await expect(
    page.getByRole("heading", { name: "Device login" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("hawlader.session.v1")),
  ).toBeNull();
  await page.getByLabel("Password").fill("739152");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Unlocked workspace" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(localStorage.getItem("hawlader.offline-login.v1")),
      ),
    )
    .toBe(true);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("hawlader.offline-login.v1"),
    ),
  ).not.toContain("739152");
  expect(
    await page.evaluate(() => localStorage.getItem("hawlader.session.v1")),
  ).toBeNull();
  await page.evaluate(() => localStorage.setItem("offline", "true"));
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Device login" }),
  ).toBeVisible();
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Incorrect");
  await expect(
    page.getByRole("heading", { name: "Unlocked workspace" }),
  ).toHaveCount(0);
  await page.getByLabel("Password").fill("739152");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Unlocked workspace" }),
  ).toBeVisible();
  const writesBefore = requests.length;
  await page.getByRole("button", { name: "Save offline sale" }).click();
  await expect(page.getByTestId("stock")).toHaveText("11");
  await expect(page.getByTestId("pending")).toHaveText("1");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Device login" }),
  ).toBeVisible();
  await page.getByLabel("Password").fill("739152");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Unlocked workspace" }),
  ).toBeVisible();
  await expect(page.getByTestId("pending")).toHaveText("1");
  await page.getByRole("button", { name: "Read stock" }).click();
  await expect(page.getByTestId("stock")).toHaveText("11");
  expect(requests.length).toBe(writesBefore);
  // Android can keep the JS runtime alive after Back instead of terminating it.
  await page.getByRole("button", { name: "Exit with Android Back" }).click();
  await expect(
    page.getByRole("heading", { name: "Device login" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean((window as unknown as { deviceExited?: boolean }).deviceExited),
      ),
    )
    .toBe(true);
  await page.getByLabel("Password").fill("739152");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Unlocked workspace" }),
  ).toBeVisible();
  await expect(page.getByTestId("pending")).toHaveText("1");
  await page.getByRole("button", { name: "Read stock" }).click();
  await expect(page.getByTestId("stock")).toHaveText("11");
  expect(requests.length).toBe(writesBefore);
});
