# DollarDisha deployment

## Deploy to Render

1. Create a new GitHub repository and upload this folder.
2. In Render, choose **New → Blueprint** and select that repository.
3. When prompted, set `FMP_API_KEY` to your Financial Modeling Prep API key.
4. Deploy. Render gives the app a temporary `onrender.com` address.
5. In the Render service settings, add the custom domain `dollardisha.in` and also add `www.dollardisha.in`.
6. Copy the DNS records Render displays into your domain registrar's DNS dashboard. Use Render's DNS values exactly; do not copy values from another guide.
7. Redirect `www.dollardisha.in` to `dollardisha.in` after DNS verifies.

The API key is an environment variable in Render. Never add it to this repository or a browser-side file.
